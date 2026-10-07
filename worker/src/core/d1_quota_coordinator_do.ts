/**
 * Optional per-shard Durable Object coordinator for D1 quota telemetry.
 *
 * A shard maps to one object name, so all isolate deltas are serialized by the
 * Durable Object. Delta ids are retained for three UTC days; older deltas are
 * rejected even after cleanup. The DO counts accepted deltas; KV is a bounded
 * visible snapshot and is never used for read-modify-write aggregation.
 */

const D1_QUOTA_FLUSH_INTERVAL_MS = 300_000;
const RETENTION_DAYS = 3;
const CLEANUP_BATCH_SIZE = 128;
const DAY_MS = 86_400_000;
const RETENTION_FLOOR_KEY = "meta:retention_floor";
const KV_LAST_ATTEMPT_KEY = "meta:kv_last_attempt_at";
const D1_QUOTA_KV_PREFIX = "one-mail:d1quota:";
const STATE_PREFIX = "state:";
const DELTA_PREFIX = "delta:";
const SNAPSHOT_TTL_SECONDS = 3 * 24 * 60 * 60;

type CoordinatorState = {
    v: 1;
    shard_id: string;
    utc_date: string;
    rows_read: number;
    rows_written: number;
    flushed_at: number;
    flush_count: number;
    last_kv_snapshot_at: number;
};

type DeltaRequest = {
    action?: "delta";
    shard_id?: string;
    utc_date?: string;
    delta_id?: string;
    rows_read?: number;
    rows_written?: number;
    now?: number;
};

type CoordinatorClock = { now(): number };

type CoordinatorEnvironment = {
    // This is deliberately optional. Main integration must bind the existing
    // quota KV namespace to the DO under this name to publish snapshots.
    D1_QUOTA_KV?: KVNamespace;
};

const isSafeCounter = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const validUtcDate = (value: unknown): value is string =>
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

const validId = (value: unknown): value is string =>
    typeof value === "string" && value.length >= 8 && value.length <= 200;

const stateKey = (utcDate: string): string => `${STATE_PREFIX}${utcDate}`;
const deltaKey = (utcDate: string, deltaId: string): string => `${DELTA_PREFIX}${utcDate}:${deltaId}`;
const snapshotKey = (utcDate: string): string => `${D1_QUOTA_KV_PREFIX}${utcDate}`;

const emptyState = (shardId: string, utcDate: string): CoordinatorState => ({
    v: 1,
    shard_id: shardId,
    utc_date: utcDate,
    rows_read: 0,
    rows_written: 0,
    flushed_at: 0,
    flush_count: 0,
    last_kv_snapshot_at: 0,
});

const publicSnapshot = (state: CoordinatorState): Omit<CoordinatorState, "last_kv_snapshot_at"> => ({
    v: 1,
    shard_id: state.shard_id,
    utc_date: state.utc_date,
    rows_read: state.rows_read,
    rows_written: state.rows_written,
    flushed_at: state.flushed_at,
    flush_count: state.flush_count,
});

class CounterOverflowError extends Error {
    constructor() { super("quota counter overflow"); }
}

const checkedState = (stored: CoordinatorState | undefined, shardId: string, date: string): CoordinatorState => {
    if (!stored) return emptyState(shardId, date);
    if (stored.v !== 1 || stored.shard_id !== shardId || stored.utc_date !== date
        || ![stored.rows_read, stored.rows_written, stored.flushed_at, stored.flush_count, stored.last_kv_snapshot_at].every(isSafeCounter)) {
        throw new Error("invalid persisted quota state or shard identity");
    }
    return stored;
};

export class D1QuotaCoordinatorDurableObject implements DurableObject {
    private requestChain: Promise<unknown> = Promise.resolve();
    private readonly state: DurableObjectState;
    private readonly env: CoordinatorEnvironment;
    private readonly clock: CoordinatorClock;

    constructor(state: DurableObjectState, env: CoordinatorEnvironment, clock: CoordinatorClock = { now: () => Date.now() }) {
        this.state = state;
        this.env = env;
        this.clock = clock;
    }

    fetch(request: Request): Promise<Response> {
        const operation = this.requestChain.then(() => this.handle(request));
        this.requestChain = operation.catch(() => undefined);
        return operation;
    }

    alarm(): Promise<void> {
        const operation = this.requestChain.then(() => this.cleanup());
        // The alarm promise remains rejected for platform retry; this chain only
        // keeps a failed operation from poisoning subsequent requests.
        this.requestChain = operation.catch(() => undefined);
        return operation;
    }

    private async retentionFloor(now: number): Promise<string> {
        const wallFloor = utcDateOf(now - (RETENTION_DAYS - 1) * DAY_MS);
        const persisted = await this.state.storage.get<string>(RETENTION_FLOOR_KEY);
        if (persisted !== undefined && !validUtcDate(persisted)) throw new Error("invalid quota retention floor");
        return persisted && persisted > wallFloor ? persisted : wallFloor;
    }

    private async ensureAlarm(now: number): Promise<void> {
        const alarm = await this.state.storage.getAlarm();
        if (alarm === null) await this.state.storage.setAlarm((Math.floor(now / DAY_MS) + 1) * DAY_MS + 1_000);
    }

    private async cleanup(): Promise<void> {
        const now = this.clock.now();
        const floor = await this.retentionFloor(now);
        // Persist the replay rejection floor before deleting any dedup marker.
        await this.state.storage.put(RETENTION_FLOOR_KEY, floor);
        let more = false;
        for (const prefix of [DELTA_PREFIX, STATE_PREFIX]) {
            const end = `${prefix}${floor}${prefix === DELTA_PREFIX ? ":" : ""}`;
            const expired = await this.state.storage.list({ prefix, end, limit: CLEANUP_BATCH_SIZE });
            if (expired.size) await this.state.storage.delete([...expired.keys()]);
            more ||= expired.size === CLEANUP_BATCH_SIZE;
        }
        await this.state.storage.setAlarm(more ? now + 1_000 : (Math.floor(now / DAY_MS) + 1) * DAY_MS + 1_000);
    }

    private async handle(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const utcDate = url.searchParams.get("utc_date") ?? "";
        const now = this.clock.now();
        const today = utcDateOf(now);
        const floor = await this.retentionFloor(now);
        await this.ensureAlarm(now);
        if (request.method === "GET") {
            const shardId = url.searchParams.get("shard_id") ?? "";
            if (!validUtcDate(utcDate) || !shardId) return Response.json({ ok: false, error: "invalid quota identity" }, { status: 400 });
            if (utcDate > today) return Response.json({ ok: false, error: "future quota date" }, { status: 400 });
            if (utcDate < floor) return Response.json({ ok: false, error_code: "QUOTA_DELTA_EXPIRED" }, { status: 410 });
            const stored = await this.state.storage.get<CoordinatorState>(stateKey(utcDate));
            return Response.json({ ok: true, available: Boolean(stored), confidence: "partial", snapshot: publicSnapshot(checkedState(stored, shardId, utcDate)) });
        }
        if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

        const body = await request.json<DeltaRequest>().catch(() => null);
        if (!body || body.action !== "delta" || !validUtcDate(body.utc_date)
            || !validId(body.delta_id) || typeof body.shard_id !== "string" || !body.shard_id
            || !isSafeCounter(body.rows_read) || !isSafeCounter(body.rows_written)
            || (!isSafeCounter(body.now) || body.now <= 0 || body.now > 8_640_000_000_000_000)) {
            return Response.json({ ok: false, error: "invalid quota delta" }, { status: 400 });
        }

        const date = body.utc_date;
        if (date > today) return Response.json({ ok: false, error: "future quota date" }, { status: 400 });
        if (date < floor) return Response.json({ ok: false, error_code: "QUOTA_DELTA_EXPIRED" }, { status: 410 });
        const id = body.delta_id;
        const key = stateKey(date);
        const deltaMarker = deltaKey(date, id);
        let result: { state: CoordinatorState; duplicate: boolean; snapshotDue: boolean };
        try {
            result = await this.state.storage.transaction(async (txn) => {
                const current = checkedState(await txn.get<CoordinatorState>(key), body.shard_id!, date);
                const lastAttempt = await txn.get<number>(KV_LAST_ATTEMPT_KEY) ?? current.last_kv_snapshot_at;
                if (!isSafeCounter(lastAttempt)) throw new Error("invalid quota publication clock");
                const snapshotDue = Boolean(this.env.D1_QUOTA_KV)
                    && (lastAttempt === 0 || now - lastAttempt >= D1_QUOTA_FLUSH_INTERVAL_MS);
                if (snapshotDue && !isSafeCounter(current.flush_count + 1)) throw new CounterOverflowError();
                const duplicate = (await txn.get<boolean>(deltaMarker)) === true;
                if (duplicate) {
                    return {
                        state: current,
                        duplicate: true,
                        snapshotDue,
                    };
                }
                const next: CoordinatorState = {
                    ...current,
                    rows_read: current.rows_read + body.rows_read!,
                    rows_written: current.rows_written + body.rows_written!,
                };
                if (!isSafeCounter(next.rows_read) || !isSafeCounter(next.rows_written)
                    || !isSafeCounter(next.flush_count + 1)) throw new CounterOverflowError();
                await txn.put(deltaMarker, true);
                await txn.put(key, next);
                return {
                    state: next,
                    duplicate: false,
                    snapshotDue,
                };
        });

        if (result.snapshotDue && this.env.D1_QUOTA_KV) {
            // Reserve this coordinator's publication slot before external I/O. Unknown
            // outcomes cannot cause unbounded retry writes, even across UTC days.
            await this.state.storage.put(KV_LAST_ATTEMPT_KEY, now);
            const nextSnapshot = {
                ...publicSnapshot(result.state),
                flushed_at: now,
                flush_count: result.state.flush_count + 1,
            };
            try {
                await this.env.D1_QUOTA_KV.put(
                    snapshotKey(date),
                    JSON.stringify(nextSnapshot),
                    { expirationTtl: SNAPSHOT_TTL_SECONDS },
                );
            } catch (cause) {
                // The authoritative DO transaction remains committed. Returning
                // an error makes the caller retain the same delta id and retry.
                // Early retries may acknowledge the committed delta, but do not
                // republish KV until the five-minute slot is available.
                throw new Error("quota snapshot publication failed", { cause });
            }
            result = await this.state.storage.transaction(async (txn) => {
                const current = await txn.get<CoordinatorState>(key) ?? result.state;
                // A later request cannot overtake this DO instance, but never
                // move the marker backwards if storage is restored/replayed.
                const updated: CoordinatorState = {
                    ...current,
                    flushed_at: now,
                    flush_count: Math.max(current.flush_count, result.state.flush_count + 1),
                    last_kv_snapshot_at: Math.max(current.last_kv_snapshot_at, now),
                };
                await txn.put(key, updated);
                return { state: updated, duplicate: result.duplicate, snapshotDue: false };
            });
        }

        } catch (cause) {
            if (cause instanceof CounterOverflowError) return Response.json({ ok: false, error_code: "QUOTA_COUNTER_OVERFLOW" }, { status: 422 });
            console.error("quota coordination failed", { error: cause });
            return Response.json(
                { ok: false, error: "quota coordination failed" },
                { status: 503 },
            );
        }

        const todayState = today === date
            ? result.state
            : await this.state.storage.get<CoordinatorState>(stateKey(today)) ?? emptyState(body.shard_id!, today);
        return Response.json({
            ok: true,
            duplicate: result.duplicate,
            snapshot: publicSnapshot(result.state),
            today: publicSnapshot(todayState),
            coordinated: true,
        });
    }
}

const utcDateOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const quotaCoordinatorStateKeyForTests = stateKey;
export const quotaCoordinatorDeltaKeyForTests = deltaKey;
