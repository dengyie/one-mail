/**
 * Per-database D1 quota breakdown for the admin statistics dashboard.
 *
 * The local (primary) view is always reported. Remote shards are queried over
 * the existing `/shard/quota` endpoint only when the shard registry lists them,
 * so a legacy-static deployment (empty shard map) keeps today's single-card
 * payload.
 *
 * This path performs no D1 reads: `/admin/d1_quota` must stay usable while the
 * daily D1 read quota is exhausted, so account ownership is taken from the
 * shard registry (KV, cached) and never by counting rows.
 *
 * Error policy, which is deliberately asymmetric within this one function:
 * a `viewD1Quota` failure propagates (metering is this endpoint's subject and
 * must not be reported as if it succeeded), while a registry failure degrades
 * to the primary card alone (the registry is optional telemetry; an unreadable
 * or malformed map must not hide the primary database behind a 500).
 */
import type { Context } from "hono";
import {
    D1_ROWS_READ_LIMIT, D1_ROWS_WRITTEN_LIMIT, utcDateOf, viewD1Quota, type D1QuotaView,
} from "../core/d1_quota.ts";
import {
    createShardResponseBudget, fanOutShards, SHARD_LIST_MAX_BYTES, type ShardFetchOptions,
} from "./shard_client.ts";
import { SHARD_FETCH_TIMEOUT_MS } from "./shard_merge.ts";
import { accountsOnShard, hasRemoteShards, loadShardMap, type ShardMap } from "./shard_map.ts";

export type D1QuotaShardReport = D1QuotaView & {
    /** Account ids the registry assigns to this database. Empty for the primary,
     * which owns every account the registry does not list. */
    account_ids: string[];
    /** False for the primary shard: its account set is "everything else" and is
     * not enumerated here to keep this path free of D1 reads. */
    accounts_known: boolean;
    /** False when a registered shard could not be reached; the card still shows
     * with an explicit unavailable marker instead of disappearing. */
    reachable: boolean;
    /** Short transport reason when reachable is false (`timeout`, `http_502`,
     * `invalid_quota_payload`, ...), so the operator sees *why* it is blank.
     * Null for reachable rows. */
    unavailable_reason: string | null;
};

const isFiniteNumber = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);

const isQuotaDelta = (value: unknown): boolean => {
    if (value === null || typeof value !== "object") return false;
    const delta = value as { rows_read?: unknown; rows_written?: unknown };
    return isFiniteNumber(delta.rows_read) && isFiniteNumber(delta.rows_written);
};

/**
 * `/shard/quota` is a different trust domain: a 200 whose body does not match
 * the quota contract must degrade to "unreachable" rather than spread junk into
 * the card (TypeScript view types are erased at runtime). A response that fails
 * this guard is reported as `invalid_quota_payload`, never as zeroed metrics.
 */
export const isD1QuotaView = (value: unknown): value is D1QuotaView => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const v = value as Record<string, unknown>;
    return typeof v.shard_id === "string"
        && typeof v.utc_date === "string"
        && isFiniteNumber(v.rows_read)
        && isFiniteNumber(v.rows_written)
        && isFiniteNumber(v.rows_read_limit)
        && isFiniteNumber(v.rows_written_limit)
        && isFiniteNumber(v.rows_read_pct)
        && isFiniteNumber(v.rows_written_pct)
        && isQuotaDelta(v.pending_unflushed)
        && (v.flushed_at === null || isFiniteNumber(v.flushed_at))
        && isFiniteNumber(v.flush_count)
        && typeof v.aggregation_mode === "string"
        && typeof v.confidence === "string"
        && Array.isArray(v.accounting_issues);
};

const unavailableReport = (
    shardId: string,
    accountIds: string[],
    accountsKnown: boolean,
    reason: string,
): D1QuotaShardReport => ({
    shard_id: shardId,
    utc_date: utcDateOf(Date.now()),
    rows_read: 0,
    rows_written: 0,
    rows_read_limit: D1_ROWS_READ_LIMIT,
    rows_written_limit: D1_ROWS_WRITTEN_LIMIT,
    rows_read_pct: 0,
    rows_written_pct: 0,
    pending_unflushed: { rows_read: 0, rows_written: 0 },
    flushed_at: null,
    flush_count: 0,
    aggregation_mode: "unavailable",
    confidence: "stale",
    accounting_issues: ["UNREACHABLE"],
    account_ids: accountIds,
    accounts_known: accountsKnown,
    reachable: false,
    unavailable_reason: reason,
});

export const d1QuotaByShard = async (c: Context<HonoCustomType>): Promise<D1QuotaShardReport[]> => {
    const local = await viewD1Quota(c.env);
    const reports: D1QuotaShardReport[] = [{
        ...local,
        account_ids: [],
        accounts_known: false,
        reachable: true,
        unavailable_reason: null,
    }];
    let map: ShardMap;
    try {
        map = await loadShardMap(c.env);
    } catch {
        // Registry outage (unreadable or malformed map): fall back to the
        // single primary card instead of failing the whole endpoint.
        return reports;
    }
    if (!hasRemoteShards(map)) return reports;
    const limits: ShardFetchOptions = {
        deadlineAtMs: performance.now() + SHARD_FETCH_TIMEOUT_MS,
        signal: c.req.raw?.signal,
        responseBudget: createShardResponseBudget(),
        maxBodyBytes: SHARD_LIST_MAX_BYTES,
    };
    const results = await fanOutShards<unknown>(map.shards, "/shard/quota", limits);
    const byShard = new Map(results.map((result) => [result.shard_id, result]));
    for (const shard of map.shards) {
        const accountIds = accountsOnShard(map, shard.id);
        const result = byShard.get(shard.id);
        if (result?.ok && isD1QuotaView(result.data)) {
            reports.push({
                ...result.data,
                shard_id: shard.id,
                account_ids: accountIds,
                accounts_known: true,
                reachable: true,
                unavailable_reason: null,
            });
            continue;
        }
        // A registered shard that silently disappears is indistinguishable from
        // one that was never registered, so surface both the row and the reason.
        const reason = result?.ok ? "invalid_quota_payload" : (result?.error ?? "unreachable");
        console.warn(`[d1-quota] shard ${shard.id} unreachable: ${reason}`);
        reports.push(unavailableReport(shard.id, accountIds, true, reason));
    }
    return reports;
};