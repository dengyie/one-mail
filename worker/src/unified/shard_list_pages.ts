/**
 * 统一收件箱列表的远端分页拉取（自 federation.ts 拆出，行数预算门）。
 *
 * 只负责「每个归属分片拉到刚好能影响全局边界的页数」：每线一页 100 行、
 * 首页才带 COUNT（P4 degraded 分片强制关闭）、游标续页按全局边界收敛。
 * 归并/校验语义与页内约束见 federation.ts 与 shard_merge.ts。
 */
import type { FederatedListInput, ScopedTarget } from "./federation.ts";
import {
    fanOutShardRequests, type ShardFetchOptions, type ShardRequest,
} from "./shard_client.ts";
import { encodeEmailCursor } from "./cursor.ts";
import {
    compareEmailOrder, mergeSortedEmailPages, type MergeEmailRow,
} from "./shard_merge.ts";
import type { UnifiedListRow } from "./unified_list.ts";

export type RemoteList = { results?: UnifiedListRow[]; count?: number | null; has_more?: boolean; next_cursor?: string | null };
const MAX_REMOTE_LIST_CALLS = 24;

const validRemotePage = (data: RemoteList, limit: number): data is RemoteList & { results: UnifiedListRow[] } => {
    if (!Array.isArray(data.results) || data.results.length > limit) return false;
    const ids = new Set<string>();
    for (let index = 0; index < data.results.length; index++) {
        const row = data.results[index];
        if (!row || typeof row.id !== "string" || !row.id || !Number.isSafeInteger(row.received_at) || ids.has(row.id)) return false;
        if (index && compareEmailOrder(data.results[index - 1], row) > 0) return false;
        ids.add(row.id);
    }
    return data.count == null || (Number.isSafeInteger(data.count) && data.count >= 0);
};

/** Fetch only continuations that can affect the global boundary. Every wire page
 * has <=100 rows; an offset of 500 does not request 600 rows from every owner. */
export const remoteListPages = async (
    targets: ScopedTarget[], input: FederatedListInput, local: MergeEmailRow[],
    needed: number, limits: ShardFetchOptions,
    countDisabled: ReadonlySet<string> = new Set<string>(),
): Promise<{ pages: MergeEmailRow[][]; counts: (number | null)[]; degraded: string[]; unavailable: string[] }> => {
    const states = targets.map(target => ({ ...target, rows: [] as UnifiedListRow[], cursor: input.offset === undefined ? input.cursor : undefined,
        count: null as number | null, more: true, failed: false }));
    let pending = states;
    let calls = 0;
    const pageSize = Math.min(100, needed);
    while (pending.length) {
        // At 12 owners, reserve 12 initial COUNTs plus primary auth/query work
        // below the 50-query interaction budget; continuations never recount.
        if (calls + pending.length > MAX_REMOTE_LIST_CALLS) { for (const state of pending) state.failed = true; break; }
        calls += pending.length;
        const requests: ShardRequest[] = pending.map(state => ({
            shard: state.shard, path: "/shard/emails", init: {
                method: "POST", scope: state.scope,
                body: {
                    account_ids: state.scope.account_ids, source: input.rest.source,
                    unread: input.rest.unread, starred: input.rest.starred, q: input.rest.q,
                    since: input.rest.since, until: input.rest.until, to_addr: input.rest.to_addr,
                    limit: pageSize, cursor: state.cursor,
                    // P4 熔断 degraded 档：远端 COUNT 直接关闭（80%+），列表继续。
                    with_count: input.withCount && state.rows.length === 0
                        && !countDisabled.has(state.shard.id) ? 1 : 0,
                },
            },
        }));
        const results = await fanOutShardRequests<RemoteList>(requests, limits);
        for (let index = 0; index < results.length; index++) {
            const result = results[index];
            const state = pending[index];
            if (!result.ok || !validRemotePage(result.data, pageSize)) { state.failed = true; continue; }
            const rows = result.data.results;
            const previous = state.rows.at(-1);
            if (previous && rows.length && compareEmailOrder(previous, rows[0]) >= 0) { state.failed = true; continue; }
            if (state.rows.length === 0) state.count = result.data.count ?? null;
            state.rows.push(...rows);
            state.more = result.data.has_more === true && rows.length === pageSize;
            const last = rows.at(-1);
            state.cursor = state.more && last ? encodeEmailCursor(last.received_at, last.id) : undefined;
        }
        const merged = mergeSortedEmailPages([local, ...states.map(state => state.rows)], needed);
        const boundary = merged.length === needed ? merged.at(-1) : undefined;
        pending = states.filter(state => !state.failed && state.more
            && (!boundary || compareEmailOrder(state.rows[state.rows.length - 1], boundary) < 0));
    }
    return {
        pages: states.map(state => state.rows), counts: states.map(state => state.count),
        degraded: states.filter(state => state.failed).map(state => state.shard.id),
        unavailable: states.filter(state => state.failed).flatMap(state => state.scope.account_ids ?? []),
    };
};

