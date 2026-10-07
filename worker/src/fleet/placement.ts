import type { FleetConfig, MetricReport, MetricSeries, ResourceBudget } from "./contracts.ts";
import { indexValue, safeAdd } from "./validation.ts";

export const METRIC_MAX_AGE_MS = 15 * 60 * 1000;
export const METRIC_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
export const EMPTY_BUDGET: ResourceBudget = Object.freeze({ reserved_read: 0, reserved_write: 0, reserved_worker_requests: 0, reserved_bytes: 0 });

export interface PlacementInput {
    readonly config: FleetConfig;
    readonly metrics: Readonly<Record<string, MetricSeries>>;
    readonly account_reservations: Readonly<Record<string, ResourceBudget>>;
    readonly shard_reserved_bytes: Readonly<Record<string, number>>;
    readonly affinity_shards: ReadonlySet<string>;
    readonly now: number;
}

type Score = { used: bigint; limit: bigint };
type Candidate = { shard_id: string; account_key: string; score: Score; affinity: boolean };
export type PlacementDecision =
    | { readonly ok: true; readonly shard_id: string; readonly account_key: string; readonly score_ppm: number }
    | { readonly ok: false; readonly error_code: "NO_CAPACITY" | "STALE_METRICS" };

/** Only adjacent UTC five-minute buckets bootstrap eligibility. */
export function updateMetricSeries(previous: MetricSeries | undefined, report: MetricReport, now: number): MetricSeries {
    const current = report.snapshot;
    const observed = Date.parse(current.observed_at);
    const baseline = previous?.baseline ?? (previous && previous.consecutive_valid_samples > 0 ? previous.report : undefined);
    const valid = current.confidence === "authoritative" && current.source !== "application_meta"
        && current.utc_date === new Date(now).toISOString().slice(0, 10)
        && current.observed_at.slice(0, 10) === current.utc_date
        && observed <= now && now - observed <= METRIC_MAX_AGE_MS;
    if (!valid) return { report, consecutive_valid_samples: 0, baseline };
    if (!baseline || baseline.snapshot.utc_date !== current.utc_date) return { report, consecutive_valid_samples: 1, baseline: report };
    const before = baseline.snapshot;
    const priorTime = Date.parse(before.observed_at);
    if (observed < priorTime || current.rows_read < before.rows_read || current.rows_written < before.rows_written || current.worker_requests < before.worker_requests) {
        return { report, consecutive_valid_samples: 0, baseline };
    }
    const bucket = Math.floor(observed / METRIC_SAMPLE_INTERVAL_MS);
    const previousBucket = Math.floor(priorTime / METRIC_SAMPLE_INTERVAL_MS);
    const previousCount = previous?.consecutive_valid_samples ?? 0;
    let consecutive = 1;
    if (bucket === previousBucket && previousCount > 0) consecutive = previousCount;
    if (bucket === previousBucket + 1 && previousCount > 0) consecutive = Math.min(previousCount + 1, 3);
    return { report, consecutive_valid_samples: consecutive, baseline: report };
}

const compare = (a: Score, b: Score): number => {
    const delta = a.used * b.limit - b.used * a.limit;
    return delta === 0n ? 0 : (delta < 0n ? -1 : 1);
};

function maximumScore(values: readonly [number, number][]): Score {
    let maximum: Score = { used: 0n, limit: 1n };
    for (const [used, limit] of values) {
        const score = { used: BigInt(used), limit: BigInt(limit) };
        if (compare(score, maximum) > 0) maximum = score;
    }
    return maximum;
}

const withinAffinityWindow = (score: Score, best: Score): boolean =>
    20n * (score.used * best.limit - best.used * score.limit) <= score.limit * best.limit;

/** O(S), S <= 12. All reservations on sibling DBs consume one account budget. */
export function choosePlacement(input: PlacementInput): PlacementDecision {
    const { config, now } = input;
    const accounts = new Map(config.accounts.map(account => [account.account_key, account]));
    const candidates: Candidate[] = [];
    let best: Candidate | undefined;
    let stale = false;
    for (const shard of config.shards) {
        const account = accounts.get(shard.account_key);
        if (!account?.enabled || shard.shard_id === config.primary_shard_id || shard.state !== "healthy"
            || shard.schema_version !== config.required_schema_version || shard.protocol_version !== config.required_protocol_version) continue;
        const series = indexValue(input.metrics, account.account_key);
        const snapshot = series?.report.snapshot;
        const observed = snapshot ? Date.parse(snapshot.observed_at) : NaN;
        const size = snapshot ? indexValue(snapshot.shard_sizes, shard.shard_id) : undefined;
        if (!series || series.consecutive_valid_samples < 3 || !snapshot || snapshot.confidence !== "authoritative"
            || snapshot.source === "application_meta" || snapshot.observed_at.slice(0, 10) !== snapshot.utc_date
            || snapshot.utc_date !== new Date(now).toISOString().slice(0, 10)
            || !Number.isFinite(observed) || observed > now || now - observed > METRIC_MAX_AGE_MS || size === undefined) {
            stale = true;
            continue;
        }
        const reserved = indexValue(input.account_reservations, account.account_key) ?? EMPTY_BUDGET;
        const demand = config.allocation_budget;
        const score = maximumScore([
            [safeAdd(series.report.projected_rows_read, reserved.reserved_read, demand.reserved_read), account.daily_read_limit],
            [safeAdd(series.report.projected_rows_written, reserved.reserved_write, demand.reserved_write), account.daily_write_limit],
            [safeAdd(series.report.projected_worker_requests, reserved.reserved_worker_requests, demand.reserved_worker_requests), account.worker_request_limit],
            [safeAdd(size, indexValue(input.shard_reserved_bytes, shard.shard_id) ?? 0, demand.reserved_bytes), shard.storage_limit_bytes],
        ]);
        if (score.used * 10n >= score.limit * 7n) continue;
        const candidate = { shard_id: shard.shard_id, account_key: account.account_key, score, affinity: input.affinity_shards.has(shard.shard_id) };
        candidates.push(candidate);
        if (!best || compare(score, best.score) < 0) best = candidate;
    }
    if (!best) return { ok: false, error_code: stale ? "STALE_METRICS" : "NO_CAPACITY" };
    let selected: Candidate | undefined;
    for (const candidate of candidates) {
        if (!withinAffinityWindow(candidate.score, best.score)) continue;
        if (!selected || (candidate.affinity && !selected.affinity)
            || (candidate.affinity === selected.affinity && compare(candidate.score, selected.score) < 0)
            || (candidate.affinity === selected.affinity && compare(candidate.score, selected.score) === 0 && candidate.shard_id < selected.shard_id)) selected = candidate;
    }
    const winner = selected!;
    return { ok: true, shard_id: winner.shard_id, account_key: winner.account_key, score_ppm: Number((winner.score.used * 1_000_000n + winner.score.limit - 1n) / winner.score.limit) };
}
