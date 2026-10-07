/**
 * D1 rows_read / rows_written telemetry (thin-shard P0).
 *
 * Binding results already carry meta.rows_read / meta.rows_written. This module
 * wraps the D1 handle so every prepare/batch path is counted without touching
 * call sites and accumulates UTC-day buckets in isolate memory. A flush writes
 * at most one bucket, with >= FLUSH_INTERVAL_MS between successful writes in
 * this isolate, including cron/force calls (free-tier KV = 1_000 writes/day).
 *
 * Ingest is never gated on these counters. KV has no CAS and is eventually
 * consistent: cross-isolate totals and the global write budget are approximate.
 * Isolate eviction can lose pending deltas and the local throttle/cache.
 */

export const D1_ROWS_READ_LIMIT = 5_000_000;
export const D1_ROWS_WRITTEN_LIMIT = 100_000;
export const D1_QUOTA_FLUSH_INTERVAL_MS = 300_000;
export const D1_QUOTA_ATTEMPT_INTERVAL_MS = 30_000;
export const D1_QUOTA_KV_PREFIX = "one-mail:d1quota:";
export const D1_QUOTA_COORDINATOR_PATH = "/quota/delta";

export type QuotaDelta = {
    rows_read: number;
    rows_written: number;
};

export type D1QuotaSnapshot = {
    v: 1;
    shard_id: string;
    utc_date: string;
    rows_read: number;
    rows_written: number;
    flushed_at: number;
    flush_count: number;
};

export type D1QuotaView = {
    shard_id: string;
    utc_date: string;
    rows_read: number;
    rows_written: number;
    rows_read_limit: number;
    rows_written_limit: number;
    rows_read_pct: number;
    rows_written_pct: number;
    pending_unflushed: QuotaDelta;
    flushed_at: number | null;
    flush_count: number;
    aggregation_mode: "durable_object" | "best_effort_kv" | "unavailable";
    // D1 meta cannot cover account-wide management/other-project queries.
    confidence: "partial" | "stale";
    accounting_issues: string[];
};

export type QuotaClock = { now(): number };

const defaultClock: QuotaClock = { now: () => Date.now() };

const pendingByDate = new Map<string, QuotaDelta>();
const lastKnownSnapshots = new Map<string, D1QuotaSnapshot>();
let lastFlushAttemptAt: number | null = null;
let lastSuccessfulWriteAt: number | null = null;
let flushInFlight: Promise<D1QuotaSnapshot> | null = null;
const coordinatorDeltaByDate = new Map<string, { id: string; delta: QuotaDelta }>();
let clock: QuotaClock = defaultClock;
const accountingIssues = new Set<string>();
const missingSnapshots = new Set<string>();

type QuotaCoordinatorNamespace = {
    getByName(name: string): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
};

type QuotaCoordinatorBindings = {
    D1_QUOTA_COORDINATOR?: QuotaCoordinatorNamespace;
};

const coordinatorFor = (env: Bindings): QuotaCoordinatorNamespace | undefined =>
    (env as unknown as QuotaCoordinatorBindings).D1_QUOTA_COORDINATOR;

export class QuotaTelemetryError extends Error {
    readonly operation: "get" | "put" | "parse" | "coordinator";
    readonly shard_id: string;
    readonly utc_date: string;
    readonly key: string;
    readonly status?: number;

    constructor(
        operation: "get" | "put" | "parse" | "coordinator",
        shard_id: string,
        utc_date: string,
        key: string,
        cause: unknown,
        status?: number,
    ) {
        super(`D1 quota telemetry ${operation} failed for ${shard_id}/${utc_date} (${key})`, { cause });
        this.name = "QuotaTelemetryError";
        this.operation = operation;
        this.shard_id = shard_id;
        this.utc_date = utc_date;
        this.key = key;
        this.status = status;
    }
}

const isSafeCounter = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const checkedSum = (left: number, right: number): number => {
    if (!isSafeCounter(left) || !isSafeCounter(right) || !Number.isSafeInteger(left + right)) {
        throw new RangeError("D1 quota counter is invalid or exceeds safe integer range");
    }
    return left + right;
};

const metaCounter = (value: unknown): number => {
    if (isSafeCounter(value)) return value;
    accountingIssues.add("INVALID_META");
    return 0;
};

export const utcDateOf = (ms: number): string =>
    new Date(ms).toISOString().slice(0, 10);

export const d1QuotaKvKey = (utcDate: string): string =>
    `${D1_QUOTA_KV_PREFIX}${utcDate}`;

export const metaDelta = (
    meta: { rows_read?: number; rows_written?: number } | null | undefined,
): QuotaDelta => ({
    rows_read: metaCounter(meta?.rows_read),
    rows_written: metaCounter(meta?.rows_written),
});

const resultDelta = (result: { meta?: { rows_read?: number; rows_written?: number } } | null | undefined): QuotaDelta =>
    metaDelta(result?.meta);

export const addQuotaDelta = (target: QuotaDelta, extra: QuotaDelta): QuotaDelta => {
    const reads = checkedSum(target.rows_read, extra.rows_read);
    const writes = checkedSum(target.rows_written, extra.rows_written);
    target.rows_read = reads;
    target.rows_written = writes;
    return target;
};

export const percentOf = (used: number, limit: number): number => {
    if (limit <= 0) return 0;
    const pct = (used / limit) * 100;
    if (!Number.isFinite(pct) || pct <= 0) return 0;
    return Math.min(100, Math.round(pct * 10) / 10);
};

export const resetD1QuotaStateForTests = (nextClock: QuotaClock = defaultClock): void => {
    pendingByDate.clear();
    lastKnownSnapshots.clear();
    lastFlushAttemptAt = null;
    lastSuccessfulWriteAt = null;
    flushInFlight = null;
    coordinatorDeltaByDate.clear();
    accountingIssues.clear();
    missingSnapshots.clear();
    clock = nextClock;
};

export const peekD1QuotaPendingForTests = (
    utcDate = utcDateOf(clock.now()),
): QuotaDelta => ({ ...(pendingByDate.get(utcDate) ?? { rows_read: 0, rows_written: 0 }) });

export const recordD1Quota = (delta: QuotaDelta): void => {
    if (delta.rows_read === 0 && delta.rows_written === 0) return;
    const utcDate = utcDateOf(clock.now());
    let pending = pendingByDate.get(utcDate);
    if (!pending) {
        pending = { rows_read: 0, rows_written: 0 };
        pendingByDate.set(utcDate, pending);
    }
    try {
        addQuotaDelta(pending, delta);
    } catch (cause) {
        if (!(cause instanceof RangeError)) throw cause;
        // The D1 operation has already succeeded. Mark its incomplete telemetry
        // instead of turning a committed business write into an apparent failure.
        accountingIssues.add("COUNTER_OVERFLOW");
    }
};

const emptySnapshot = (shardId: string, utcDate: string): D1QuotaSnapshot => ({
    v: 1,
    shard_id: shardId,
    utc_date: utcDate,
    rows_read: 0,
    rows_written: 0,
    flushed_at: 0,
    flush_count: 0,
});

const parseSnapshot = (raw: string | null, shardId: string, utcDate: string): D1QuotaSnapshot => {
    if (raw === null) {
        missingSnapshots.add(utcDate);
        return emptySnapshot(shardId, utcDate);
    }
    try {
        const parsed = JSON.parse(raw) as Partial<D1QuotaSnapshot> | null;
        const isCounter = (value: unknown): value is number =>
            typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
        if (!parsed || parsed.v !== 1 || parsed.shard_id !== shardId || parsed.utc_date !== utcDate
            || !isCounter(parsed.rows_read) || !isCounter(parsed.rows_written)
            || !isCounter(parsed.flushed_at) || !isCounter(parsed.flush_count)) {
            throw new TypeError("Invalid D1 quota snapshot schema or shard/date identity");
        }
        missingSnapshots.delete(utcDate);
        return parsed as D1QuotaSnapshot;
    } catch (cause) {
        throw new QuotaTelemetryError("parse", shardId, utcDate, d1QuotaKvKey(utcDate), cause);
    }
};

export const resolveShardId = (env: { SHARD_ID?: string }): string => {
    const id = typeof env.SHARD_ID === "string" ? env.SHARD_ID.trim() : "";
    return id || "primary";
};

export const isShardMode = (env: { SHARD_MODE?: string | boolean | number }): boolean => {
    const value = env.SHARD_MODE;
    return value === true || value === 1 || value === "1" || value === "true";
};

const originals = new WeakMap<object, D1PreparedStatement>();

const wrapStatement = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(stmt, {
        get(target, prop, receiver) {
            if (prop === "bind") {
                return (...args: unknown[]) => wrapStatement(target.bind(...(args as [])));
            }
            if (prop === "first") {
                // first() does not return meta. all() is the same prepared SQL and
                // does. Callers of first() in this Worker are COUNT(*) or unique
                // lookups (0–1 rows); do not use first() on unbounded SELECT *.
                return async <T = unknown>(colName?: string): Promise<T | null> => {
                    const result = await target.all<Record<string, unknown>>();
                    recordD1Quota(resultDelta(result));
                    const row = result.results?.[0] ?? null;
                    if (row == null) return null;
                    if (colName !== undefined) {
                        if (row[colName] === undefined) {
                            throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${colName})`, {
                                cause: new Error("Column not found"),
                            });
                        }
                        return row[colName] as T;
                    }
                    return row as T;
                };
            }
            if (prop === "all") {
                return async <T = Record<string, unknown>>(...args: unknown[]) => {
                    const result = await (target.all as (...a: unknown[]) => Promise<D1Result<T>>).apply(target, args);
                    recordD1Quota(resultDelta(result));
                    return result;
                };
            }
            if (prop === "run") {
                return async (...args: unknown[]) => {
                    const result = await (target.run as (...a: unknown[]) => Promise<D1Result>).apply(target, args);
                    recordD1Quota(resultDelta(result));
                    return result;
                };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
    originals.set(wrapped, stmt);
    return wrapped;
};

const unwrapStatement = (statement: D1PreparedStatement): D1PreparedStatement =>
    originals.get(statement) ?? statement;

export const wrapD1 = (db: D1Database): D1Database => new Proxy(db, {
    get(target, prop, receiver) {
        if (prop === "prepare") {
            return (query: string) => wrapStatement(target.prepare(query));
        }
        if (prop === "batch") {
            return async <T = unknown>(statements: D1PreparedStatement[]) => {
                const results = await target.batch<T>(statements.map(unwrapStatement));
                for (const result of results) recordD1Quota(resultDelta(result));
                return results;
            };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
    },
});

export const attachD1Quota = (env: Bindings): Bindings => {
    if (!env.DB) return env;
    return { ...env, DB: wrapD1(env.DB) };
};

export const maybeFlushD1Quota = (
    env: Bindings,
    ctx: { waitUntil(promise: Promise<unknown>): void },
): void => {
    if ((!env.KV && !coordinatorFor(env)) || pendingByDate.size === 0 || flushInFlight) return;
    const now = clock.now();
    if (lastSuccessfulWriteAt !== null && now - lastSuccessfulWriteAt < D1_QUOTA_FLUSH_INTERVAL_MS) return;
    if (lastFlushAttemptAt !== null && now - lastFlushAttemptAt < D1_QUOTA_ATTEMPT_INTERVAL_MS) return;
    lastFlushAttemptAt = now;
    ctx.waitUntil(flushD1Quota(env));
};

export const flushD1Quota = async (
    env: Bindings,
    options: { force?: boolean } = {},
): Promise<D1QuotaSnapshot | null> => {
    if (!env.KV && !coordinatorFor(env)) return null;
    // Keep force for existing cron callers; it never bypasses the write budget.
    if (!flushInFlight) {
        flushInFlight = commitFlush(env).finally(() => {
            flushInFlight = null;
        });
    }
    // All callers share the commit, not an extra eventually-consistent KV read.
    return { ...await flushInFlight };
};

const rememberSnapshot = (stored: D1QuotaSnapshot): D1QuotaSnapshot => {
    const known = lastKnownSnapshots.get(stored.utc_date);
    const snapshot: D1QuotaSnapshot = known ? {
        ...stored,
        rows_read: Math.max(stored.rows_read, known.rows_read),
        rows_written: Math.max(stored.rows_written, known.rows_written),
        flushed_at: Math.max(stored.flushed_at, known.flushed_at),
        flush_count: Math.max(stored.flush_count, known.flush_count),
    } : stored;
    lastKnownSnapshots.set(stored.utc_date, snapshot);
    return snapshot;
};

const readSnapshot = async (
    kv: KVNamespace,
    shardId: string,
    utcDate: string,
): Promise<D1QuotaSnapshot> => {
    const key = d1QuotaKvKey(utcDate);
    let raw: string | null;
    try {
        raw = await kv.get(key);
    } catch (cause) {
        throw new QuotaTelemetryError("get", shardId, utcDate, key, cause);
    }
    // Read the cache after the await: a concurrent commit may have advanced it.
    return rememberSnapshot(parseSnapshot(raw, shardId, utcDate));
};

const coordinatorSnapshot = async (
    env: Bindings,
    utcDate: string,
    delta: QuotaDelta,
    deltaId: string,
): Promise<D1QuotaSnapshot> => {
    const namespace = coordinatorFor(env);
    if (!namespace) throw new Error("quota coordinator binding is absent");
    const shardId = resolveShardId(env);
    const stub = namespace.getByName(shardId);
    let response: Response;
    try {
        response = await stub.fetch(`https://quota-coordinator${D1_QUOTA_COORDINATOR_PATH}?utc_date=${encodeURIComponent(utcDate)}&shard_id=${encodeURIComponent(shardId)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                action: "delta",
                shard_id: shardId,
                utc_date: utcDate,
                delta_id: deltaId,
                rows_read: delta.rows_read,
                rows_written: delta.rows_written,
                now: clock.now(),
            }),
        });
    } catch (cause) {
        throw new QuotaTelemetryError("coordinator", shardId, utcDate, `${D1_QUOTA_COORDINATOR_PATH}/${shardId}`, cause);
    }
    if (!response.ok) {
        const cause = new Error(`coordinator returned HTTP ${response.status}`);
        let expired = false;
        if (response.status === 410) {
            try {
                const payload = await response.json() as { error_code?: string } | null;
                expired = payload?.error_code === "QUOTA_DELTA_EXPIRED";
            } catch (parseCause) {
                throw new QuotaTelemetryError("coordinator", shardId, utcDate, `${D1_QUOTA_COORDINATOR_PATH}/${shardId}`, parseCause);
            }
        }
        throw new QuotaTelemetryError("coordinator", shardId, utcDate, `${D1_QUOTA_COORDINATOR_PATH}/${shardId}`, cause, expired ? 410 : undefined);
    }
    try {
        const payload = await response.json() as { snapshot?: D1QuotaSnapshot } | null;
        if (!payload?.snapshot) throw new TypeError("missing coordinator snapshot");
        return parseSnapshot(JSON.stringify(payload.snapshot), shardId, utcDate);
    } catch (cause) {
        throw new QuotaTelemetryError("coordinator", shardId, utcDate, `${D1_QUOTA_COORDINATOR_PATH}/${shardId}`, cause);
    }
};

const readCoordinatorSnapshot = async (
    env: Bindings,
    utcDate: string,
): Promise<D1QuotaSnapshot | null> => {
    const namespace = coordinatorFor(env);
    if (!namespace) return null;
    const shardId = resolveShardId(env);
    try {
        const response = await namespace.getByName(shardId).fetch(
            `https://quota-coordinator${D1_QUOTA_COORDINATOR_PATH}?utc_date=${encodeURIComponent(utcDate)}&shard_id=${encodeURIComponent(shardId)}`,
        );
        if (!response.ok) throw new Error(`coordinator returned HTTP ${response.status}`);
        const payload = await response.json() as { snapshot?: D1QuotaSnapshot; available?: boolean };
        if (!payload.snapshot) throw new TypeError("missing coordinator snapshot");
        const snapshot = rememberSnapshot(parseSnapshot(JSON.stringify(payload.snapshot), shardId, utcDate));
        if (payload.available === false) missingSnapshots.add(utcDate);
        return snapshot;
    } catch (cause) {
        throw new QuotaTelemetryError("coordinator", shardId, utcDate, `${D1_QUOTA_COORDINATOR_PATH}/${shardId}`, cause);
    }
};

const commitCoordinatedFlush = async (env: Bindings, utcDate: string): Promise<D1QuotaSnapshot> => {
    const pending = pendingByDate.get(utcDate);
    if (!pending) return (await readCoordinatorSnapshot(env, utcDate)) ?? emptySnapshot(resolveShardId(env), utcDate);
    let batch = coordinatorDeltaByDate.get(utcDate);
    if (!batch) {
        // Every committed batch needs a fresh id. Reusing one per UTC day would
        // make the coordinator treat later flushes as duplicate retries.
        batch = { id: `${utcDate}:${crypto.randomUUID()}`, delta: { ...pending } };
        coordinatorDeltaByDate.set(utcDate, batch);
    }
    let result: D1QuotaSnapshot;
    try {
        result = await coordinatorSnapshot(env, utcDate, batch.delta, batch.id);
    } catch (cause) {
        if (cause instanceof QuotaTelemetryError && cause.status === 410) {
            // This day can never be accepted after server-side marker cleanup.
            // Report the loss and release the expired head, so the next attempt
            // can deliver current-day deltas instead of retrying forever.
            accountingIssues.add("EXPIRED_DELTA");
            pendingByDate.delete(utcDate);
            coordinatorDeltaByDate.delete(utcDate);
        }
        throw cause;
    }
    pending.rows_read -= batch.delta.rows_read;
    pending.rows_written -= batch.delta.rows_written;
    if (pending.rows_read === 0 && pending.rows_written === 0) pendingByDate.delete(utcDate);
    coordinatorDeltaByDate.delete(utcDate);
    lastSuccessfulWriteAt = clock.now();
    return rememberSnapshot(result);
};

const commitFlush = async (env: Bindings): Promise<D1QuotaSnapshot> => {
    const shardId = resolveShardId(env);
    const today = utcDateOf(clock.now());
    // Map insertion order drains the oldest recorded day without sorting/scans.
    const utcDate = pendingByDate.keys().next().value as string | undefined;
    if (coordinatorFor(env)) {
        return commitCoordinatedFlush(env, utcDate ?? today);
    }
    const kv = env.KV;
    const localThrottled = lastSuccessfulWriteAt !== null
        && clock.now() - lastSuccessfulWriteAt < D1_QUOTA_FLUSH_INTERVAL_MS;
    if (!utcDate || localThrottled) return readSnapshot(kv, shardId, today);

    const pending = pendingByDate.get(utcDate)!;
    const delta = { ...pending };
    // Read today's return value before any historical write. No fallible KV
    // reads after put: a successful commit cannot be reported as a read failure.
    const todaySnapshot = utcDate === today ? null : await readSnapshot(kv, shardId, today);
    const current = rememberSnapshot(await readSnapshot(kv, shardId, utcDate));
    const now = clock.now();
    if (current.flush_count > 0 && now - current.flushed_at < D1_QUOTA_FLUSH_INTERVAL_MS) {
        // Best-effort cross-isolate throttle; KV cannot enforce a global limit.
        return todaySnapshot ? rememberSnapshot(todaySnapshot) : current;
    }

    const next: D1QuotaSnapshot = {
        v: 1,
        shard_id: shardId,
        utc_date: utcDate,
        rows_read: checkedSum(current.rows_read, delta.rows_read),
        rows_written: checkedSum(current.rows_written, delta.rows_written),
        flushed_at: now,
        flush_count: checkedSum(current.flush_count, 1),
    };
    const key = d1QuotaKvKey(utcDate);
    try {
        await kv.put(key, JSON.stringify(next), { expirationTtl: 3 * 24 * 60 * 60 });
    } catch (cause) {
        throw new QuotaTelemetryError("put", shardId, utcDate, key, cause);
    }
    lastSuccessfulWriteAt = clock.now();
    const committed = rememberSnapshot(next);
    // Records made during KV I/O stay in their original day bucket.
    pending.rows_read -= delta.rows_read;
    pending.rows_written -= delta.rows_written;
    if (pending.rows_read === 0 && pending.rows_written === 0) pendingByDate.delete(utcDate);
    return todaySnapshot ? rememberSnapshot(todaySnapshot) : committed;
};

export const viewD1Quota = async (env: Bindings): Promise<D1QuotaView> => {
    const shardId = resolveShardId(env);
    const utcDate = utcDateOf(clock.now());
    let stored = emptySnapshot(shardId, utcDate);
    let aggregation_mode: D1QuotaView["aggregation_mode"] = "unavailable";
    if (coordinatorFor(env)) {
        stored = (await readCoordinatorSnapshot(env, utcDate)) ?? stored;
        aggregation_mode = "durable_object";
    } else if (env.KV) {
        stored = rememberSnapshot(await readSnapshot(env.KV, shardId, utcDate));
        aggregation_mode = "best_effort_kv";
    }
    const pending = pendingByDate.get(utcDate) ?? { rows_read: 0, rows_written: 0 };
    const rows_read = checkedSum(stored.rows_read, pending.rows_read);
    const rows_written = checkedSum(stored.rows_written, pending.rows_written);
    const issues = new Set(accountingIssues);
    if (aggregation_mode === "unavailable") issues.add("UNAVAILABLE");
    if (missingSnapshots.has(utcDate)) issues.add("MISSING_SNAPSHOT");
    const stale = stored.flushed_at > 0 && (clock.now() - stored.flushed_at > 900_000 || stored.flushed_at > clock.now());
    if (stale) issues.add("STALE_SNAPSHOT");
    return {
        shard_id: shardId,
        utc_date: utcDate,
        rows_read,
        rows_written,
        rows_read_limit: D1_ROWS_READ_LIMIT,
        rows_written_limit: D1_ROWS_WRITTEN_LIMIT,
        rows_read_pct: percentOf(rows_read, D1_ROWS_READ_LIMIT),
        rows_written_pct: percentOf(rows_written, D1_ROWS_WRITTEN_LIMIT),
        pending_unflushed: { ...pending },
        flushed_at: stored.flushed_at > 0 ? stored.flushed_at : null,
        flush_count: stored.flush_count,
        aggregation_mode,
        confidence: stale ? "stale" : "partial",
        accounting_issues: [...issues],
    };
};
