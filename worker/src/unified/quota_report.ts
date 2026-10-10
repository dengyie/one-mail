/**
 * Per-database D1 quota breakdown for the admin statistics dashboard.
 *
 * The local (primary) view is always reported. Remote shards are queried over
 * the existing `/shard/quota` endpoint only when the shard registry lists them,
 * so a legacy-static deployment (empty shard map) keeps today's single-card
 * shape byte-for-byte.
 *
 * This path performs no D1 reads: `/admin/d1_quota` must stay usable while the
 * daily D1 read quota is exhausted, so account ownership is taken from the
 * shard registry (KV, cached) and never by counting rows.
 */
import type { Context } from "hono";
import {
    D1_ROWS_READ_LIMIT, D1_ROWS_WRITTEN_LIMIT, utcDateOf, viewD1Quota, type D1QuotaView,
} from "../core/d1_quota.ts";
import {
    createShardResponseBudget, fanOutShards, SHARD_LIST_MAX_BYTES, type ShardFetchOptions,
} from "./shard_client.ts";
import { SHARD_FETCH_TIMEOUT_MS } from "./shard_merge.ts";
import { accountsOnShard, hasRemoteShards, loadShardMap } from "./shard_map.ts";

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
};

const unavailableView = (shardId: string): D1QuotaView => ({
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
});

export const d1QuotaByShard = async (c: Context<HonoCustomType>): Promise<D1QuotaShardReport[]> => {
    const local = await viewD1Quota(c.env);
    const reports: D1QuotaShardReport[] = [{
        ...local,
        account_ids: [],
        accounts_known: false,
        reachable: true,
    }];
    let map;
    try {
        map = await loadShardMap(c.env);
    } catch {
        // A registry outage must not hide the primary card; fall back to one row.
        return reports;
    }
    if (!hasRemoteShards(map)) return reports;
    const limits: ShardFetchOptions = {
        deadlineAtMs: performance.now() + SHARD_FETCH_TIMEOUT_MS,
        signal: c.req.raw?.signal,
        responseBudget: createShardResponseBudget(),
        maxBodyBytes: SHARD_LIST_MAX_BYTES,
    };
    const results = await fanOutShards<D1QuotaView>(map.shards, "/shard/quota", limits);
    const byShard = new Map(results.map((result) => [result.shard_id, result]));
    for (const shard of map.shards) {
        const accountIds = accountsOnShard(map, shard.id);
        const result = byShard.get(shard.id);
        if (result?.ok) {
            reports.push({
                ...result.data,
                shard_id: shard.id,
                account_ids: accountIds,
                accounts_known: true,
                reachable: true,
            });
        } else {
            reports.push({
                ...unavailableView(shard.id),
                account_ids: accountIds,
                accounts_known: true,
                reachable: false,
            });
        }
    }
    return reports;
};
