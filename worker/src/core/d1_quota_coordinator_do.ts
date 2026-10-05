/**
 * Optional per-shard Durable Object coordinator for D1 quota telemetry.
 *
 * A shard maps to one object name, so all isolate deltas are serialized by the
 * Durable Object. Delta ids are retained and replaying an accepted request is
 * therefore harmless. The DO is authoritative; KV is only a bounded, operator
 * visible snapshot and is never used for read-modify-write aggregation.
 */

const D1_QUOTA_FLUSH_INTERVAL_MS = 120_000;
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

type CoordinatorEnvironment = {
    // This is deliberately optional. Main integration must bind the existing
    // quota KV namespace to the DO under this name to publish snapshots.
    D1_QUOTA_KV?: KVNamespace;
};

const isSafeCounter = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const validUtcDate = (value: unknown): value is string =>
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

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

export class D1QuotaCoordinatorDurableObject implements DurableObject {
    private requestChain: Promise<unknown> = Promise.resolve();
    private readonly state: DurableObjectState;
    private readonly env: CoordinatorEnvironment;

    constructor(state: DurableObjectState, env: CoordinatorEnvironment) {
        this.state = state;
        this.env = env;
    }

    fetch(request: Request): Promise<Response> {
        const operation = this.requestChain.then(() => this.handle(request));
        this.requestChain = operation.catch(() => undefined);
        return operation;
    }

    private async handle(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const utcDate = url.searchParams.get("utc_date") ?? "";
        if (request.method === "GET") {
            const shardId = url.searchParams.get("shard_id") ?? "";
            if (!validUtcDate(utcDate) || !shardId) return Response.json({ ok: false, error: "invalid quota identity" }, { status: 400 });
            const stored = await this.state.storage.get<CoordinatorState>(stateKey(utcDate));
            return Response.json({ ok: true, snapshot: publicSnapshot(stored ?? emptyState(shardId, utcDate)) });
        }
        if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

        const body = await request.json<DeltaRequest>().catch(() => null);
        if (!body || body.action !== "delta" || !validUtcDate(body.utc_date)
            || !validId(body.delta_id) || typeof body.shard_id !== "string" || !body.shard_id
            || !isSafeCounter(body.rows_read) || !isSafeCounter(body.rows_written)
            || (!isSafeCounter(body.now) || body.now <= 0)) {
            return Response.json({ ok: false, error: "invalid quota delta" }, { status: 400 });
        }

        const date = body.utc_date;
        const id = body.delta_id;
        const key = stateKey(date);
        const deltaMarker = deltaKey(date, id);
        let result: { state: CoordinatorState; duplicate: boolean; snapshotDue: boolean };
        try {
            result = await this.state.storage.transaction(async (txn) => {
            const current = await txn.get<CoordinatorState>(key) ?? emptyState(body.shard_id!, date);
            if (current.shard_id !== body.shard_id) throw new Error("quota shard identity mismatch");
            const duplicate = (await txn.get<boolean>(deltaMarker)) === true;
            if (duplicate) {
                return {
                    state: current,
                    duplicate: true,
                    snapshotDue: Boolean(this.env.D1_QUOTA_KV)
                        && (current.last_kv_snapshot_at === 0
                            || body.now! - current.last_kv_snapshot_at >= D1_QUOTA_FLUSH_INTERVAL_MS),
                };
            }
            const next: CoordinatorState = {
                ...current,
                rows_read: current.rows_read + body.rows_read!,
                rows_written: current.rows_written + body.rows_written!,
            };
            await txn.put(deltaMarker, true);
            await txn.put(key, next);
            return {
                state: next,
                duplicate: false,
                snapshotDue: Boolean(this.env.D1_QUOTA_KV)
                    && (current.last_kv_snapshot_at === 0
                        || body.now! - current.last_kv_snapshot_at >= D1_QUOTA_FLUSH_INTERVAL_MS),
            };
        });

        if (result.snapshotDue && this.env.D1_QUOTA_KV) {
            const nextSnapshot = {
                ...publicSnapshot(result.state),
                flushed_at: body.now,
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
                // an error makes the caller retain the same delta id and retry;
                // the retry republishes the snapshot without double counting.
                throw new Error("quota snapshot publication failed", { cause });
            }
            result = await this.state.storage.transaction(async (txn) => {
                const current = await txn.get<CoordinatorState>(key) ?? result.state;
                // A later request cannot overtake this DO instance, but never
                // move the marker backwards if storage is restored/replayed.
                const updated: CoordinatorState = {
                    ...current,
                    flushed_at: body.now!,
                    flush_count: Math.max(current.flush_count, result.state.flush_count + 1),
                    last_kv_snapshot_at: Math.max(current.last_kv_snapshot_at, body.now!),
                };
                await txn.put(key, updated);
                return { state: updated, duplicate: result.duplicate, snapshotDue: false };
            });
        }

        } catch (cause) {
            console.error("quota coordination failed", { error: cause });
            return Response.json(
                { ok: false, error: "quota coordination failed" },
                { status: 503 },
            );
        }

        const today = utcDateOf(body.now!);
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
