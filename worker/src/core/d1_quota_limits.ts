/**
 * Shared D1 budget constants for the daily telemetry view and the hourly
 * fail-closed gate. Imported by both the Worker-side quota wrapper and the
 * quota coordinator DO, so the two sides can never drift apart.
 */

export const D1_ROWS_READ_LIMIT = 5_000_000;
export const D1_ROWS_WRITTEN_LIMIT = 100_000;

// Free-tier daily limits split evenly across UTC hours. The hourly gate fails
// closed (error with a retry epoch) once a database's queries would push the
// running hour past this allowance, instead of discovering the platform's
// account-wide 7500 rejection mid-burn (failed queries still pay their scan).
export const D1_ROWS_READ_HOURLY_LIMIT = Math.floor(D1_ROWS_READ_LIMIT / 24);

// Rows pre-reserved per coordinator round trip. Reservation slop bounds the
// worst-case overshoot per isolate while keeping the gate in-memory fast.
// Small by design: the coordinator also accepts negative reservations, so the
// gate releases unused slop after a query's real meta.rows_read is known —
// a chunk that is too big turns every admission into a phantom burn (2026-11-19:
// transport-failure retries alone drained whole hourly buckets).
export const D1_HOURLY_RESERVE_CHUNK = 1_000;

/** UTC hour bucket key, e.g. `2026-11-19T08`. */
export const utcHourKeyOf = (ms: number): string => new Date(ms).toISOString().slice(0, 13);

const HOUR_KEY_RE = /^\d{4}-\d{2}-\d{2}T\d{2}$/;
const HOUR_MS = 3_600_000;

export const isHourKey = (value: unknown): value is string =>
    typeof value === "string" && HOUR_KEY_RE.test(value)
    && new Date(`${value}:00:00.000Z`).toISOString().slice(0, 13) === value;

export const hourStartOf = (hourKey: string): number =>
    Date.parse(`${hourKey}:00:00.000Z`);

/** Epoch ms at which the given hour bucket ends (the gate's retry_at). */
export const nextHourBoundaryOf = (hourKey: string): number =>
    hourStartOf(hourKey) + HOUR_MS;

// ---------------------------------------------------------------------------
// Shared quota kernel: safe counters and the cross-module accounting-issue
// ledger (surfaced as accounting_issues in the admin quota view).
// ---------------------------------------------------------------------------

export type QuotaClock = { now(): number };

export const isSafeCounter = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const checkedSum = (left: number, right: number): number => {
    if (!isSafeCounter(left) || !isSafeCounter(right) || !Number.isSafeInteger(left + right)) {
        throw new RangeError("D1 quota counter is invalid or exceeds safe integer range");
    }
    return left + right;
};

export const quotaIssues = new Set<string>();
export const flagQuotaIssue = (code: string): void => { quotaIssues.add(code); };

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

type QuotaCoordinatorNamespace = {
    getByName(name: string): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
};

type QuotaCoordinatorBindings = {
    D1_QUOTA_COORDINATOR?: QuotaCoordinatorNamespace;
};

export const coordinatorFor = (env: Bindings): QuotaCoordinatorNamespace | undefined =>
    (env as unknown as QuotaCoordinatorBindings).D1_QUOTA_COORDINATOR;

export const resolveShardId = (env: { SHARD_ID?: string }): string => {
    const id = typeof env.SHARD_ID === "string" ? env.SHARD_ID.trim() : "";
    return id || "primary";
};
