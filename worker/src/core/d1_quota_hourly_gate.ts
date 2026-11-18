/**
 * Hourly fail-closed read budget (reservation model).
 *
 * The gate keeps every database's per-UTC-hour rows_read inside the daily
 * free-tier allowance divided by 24. Each isolate spends a locally reserved
 * chunk before asking the coordinator DO for more; the DO serializes
 * reservations across isolates, so the aggregate stays near the allowance
 * instead of discovering the platform's account-wide 7500 rejection mid-burn
 * (failed queries still pay their full scan). Without a coordinator binding
 * the gate degrades to the same cap enforced on isolate-local usage only.
 * Coordinator transport failures fail open — a telemetry outage must not take
 * the mail surface down — and are surfaced via accounting_issues.
 */
import {
    D1_HOURLY_RESERVE_CHUNK,
    D1_ROWS_READ_HOURLY_LIMIT,
    checkedSum,
    coordinatorFor,
    flagQuotaIssue,
    isSafeCounter,
    nextHourBoundaryOf,
    QuotaTelemetryError,
    resolveShardId,
    utcHourKeyOf,
    type QuotaClock,
} from "./d1_quota_limits.ts";

const D1_QUOTA_COORDINATOR_PATH = "/quota/delta";

export class D1HourlyReadBudgetError extends Error {
    readonly code = "D1_HOURLY_READ_BUDGET";
    readonly retryAt: string;
    readonly hourKey: string;

    constructor(hourKey: string, retryAtMs: number) {
        super("Database hourly read budget exhausted. Retry after the UTC hour rolls over.");
        this.name = "D1HourlyReadBudgetError";
        this.hourKey = hourKey;
        this.retryAt = new Date(retryAtMs).toISOString();
    }
}

type HourlyReservation = {
    hourKey: string;
    reserved: number;
    used: number;
    exhausted: boolean;
};

let hourly: HourlyReservation | null = null;
let hourlyCoordinatorDownUntil = 0;
let clock: QuotaClock = { now: () => Date.now() };

export type HourlyGateSnapshot = {
    hourKey: string;
    reserved: number;
    used: number;
    exhausted: boolean;
};

export const peekHourlyGateState = (): HourlyGateSnapshot | null =>
    hourly ? { ...hourly } : null;

const rollHourlyIfNeeded = (): HourlyReservation => {
    const hourKey = utcHourKeyOf(clock.now());
    if (!hourly || hourly.hourKey !== hourKey) {
        hourly = { hourKey, reserved: 0, used: 0, exhausted: false };
    }
    return hourly;
};

/** Charge executed rows against the current hour (called from recordD1Quota). */
export const recordHourlyUsage = (rowsRead: number): void => {
    if (rowsRead <= 0) return;
    const bucket = rollHourlyIfNeeded();
    try {
        bucket.used = checkedSum(bucket.used, rowsRead);
    } catch (cause) {
        if (!(cause instanceof RangeError)) throw cause;
        flagQuotaIssue("COUNTER_OVERFLOW");
        bucket.used = D1_ROWS_READ_HOURLY_LIMIT;
    }
};

const coordinatorReserve = async (
    env: Bindings,
    hourKey: string,
    requested: number,
): Promise<{ granted: number; remaining: number } | null> => {
    const namespace = coordinatorFor(env);
    if (!namespace) return null;
    const shardId = resolveShardId(env);
    let response: Response;
    try {
        response = await namespace.getByName(shardId).fetch(new Request(
            `https://quota-coordinator${D1_QUOTA_COORDINATOR_PATH}?shard_id=${encodeURIComponent(shardId)}`,
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    action: "reserve",
                    shard_id: shardId,
                    hour_key: hourKey,
                    rows_read: requested,
                    now: clock.now(),
                }),
            },
        ));
    } catch (cause) {
        throw new QuotaTelemetryError("coordinator", shardId, hourKey, "reserve", cause);
    }
    if (!response.ok) {
        throw new QuotaTelemetryError("coordinator", shardId, hourKey, "reserve",
            new Error(`coordinator returned HTTP ${response.status}`));
    }
    try {
        const payload = await response.json() as { granted?: unknown; remaining?: unknown } | null;
        if (!payload || !isSafeCounter(payload.granted) || !isSafeCounter(payload.remaining)) {
            throw new TypeError("invalid reserve acknowledgement");
        }
        return { granted: payload.granted, remaining: payload.remaining };
    } catch (cause) {
        throw new QuotaTelemetryError("parse", shardId, hourKey, "reserve", cause);
    }
};

/**
 * Charge one pending database execution against the current UTC hour's read
 * budget. Throws D1HourlyReadBudgetError (fail closed) when the hour is spent.
 * `env` without a coordinator binding enforces the same cap on isolate-local
 * usage only. Coordinator transport failures fail open for this query.
 */
export const acquireHourlyReadAllowance = async (env: Bindings): Promise<void> => {
    const bucket = rollHourlyIfNeeded();
    if (bucket.used < bucket.reserved) return;
    if (bucket.exhausted) {
        throw new D1HourlyReadBudgetError(bucket.hourKey, nextHourBoundaryOf(bucket.hourKey));
    }
    if (clock.now() < hourlyCoordinatorDownUntil) {
        // Coordinator outage window: enforce the cap on isolate-local usage.
        if (bucket.used >= D1_ROWS_READ_HOURLY_LIMIT) {
            bucket.exhausted = true;
            throw new D1HourlyReadBudgetError(bucket.hourKey, nextHourBoundaryOf(bucket.hourKey));
        }
        return;
    }
    const want = Math.max(D1_HOURLY_RESERVE_CHUNK, 1);
    try {
        const coordinated = await coordinatorReserve(env, bucket.hourKey, want);
        if (!coordinated) {
            // No coordinator binding: isolate-local cap only.
            if (bucket.used >= D1_ROWS_READ_HOURLY_LIMIT) {
                bucket.exhausted = true;
                throw new D1HourlyReadBudgetError(bucket.hourKey, nextHourBoundaryOf(bucket.hourKey));
            }
            bucket.reserved = Math.max(bucket.reserved, want);
            return;
        }
        bucket.reserved = checkedSum(bucket.used, coordinated.granted);
        if (coordinated.granted === 0) {
            bucket.exhausted = true;
            throw new D1HourlyReadBudgetError(bucket.hourKey, nextHourBoundaryOf(bucket.hourKey));
        }
    } catch (cause) {
        if (cause instanceof D1HourlyReadBudgetError) throw cause;
        if (cause instanceof QuotaTelemetryError) {
            // Fail open for this query; distrust the coordinator briefly.
            flagQuotaIssue("COORDINATOR_UNAVAILABLE");
            hourlyCoordinatorDownUntil = clock.now() + 60_000;
            if (bucket.used >= D1_ROWS_READ_HOURLY_LIMIT) {
                bucket.exhausted = true;
                throw new D1HourlyReadBudgetError(bucket.hourKey, nextHourBoundaryOf(bucket.hourKey));
            }
            return;
        }
        throw cause;
    }
};

export const setHourlyGateClock = (nextClock: QuotaClock): void => {
    clock = nextClock;
};

export const resetHourlyGateForTests = (nextClock?: QuotaClock): void => {
    hourly = null;
    hourlyCoordinatorDownUntil = 0;
    if (nextClock) clock = nextClock;
};
