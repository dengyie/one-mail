import type { Context } from "hono";
import {
    createShardResponseBudget, fanOutShardRequests, fetchShardJson,
    SHARD_LIST_MAX_BYTES, SHARD_DETAIL_MAX_BYTES,
    type ShardFetchOptions, type ShardCallResult, type ShardRequest,
} from "./shard_client.ts";
import {
    groupAccountsByShard,
    hasRemoteShards,
    loadShardMap,
    shardById,
    type ShardEndpoint,
    type ShardMap,
} from "./shard_map.ts";
import {
    MAX_UNIFIED_OFFSET,
    SHARD_FETCH_TIMEOUT_MS,
    compareEmailOrder,
    mergeCounts,
    mergeSortedEmailPages,
    mergeStringSets,
    uniqueStrings,
    type MergeEmailRow,
} from "./shard_merge.ts";
import { resolveScopedEmailFilter } from "./auth_scope.ts";
import { scopeQuery } from "./api_keys.ts";
import { encodeEmailCursor } from "./cursor";
import { executeCursorList, executeUnboundedOffsetList, type UnifiedListRow } from "./unified_list.ts";
import { UNIFIED_EMAIL_ORDER, boundedEmailFilter } from "./unified_sql.ts";
import { listFolders } from "./folders.ts";
import { extractVerifCode } from "./verifcode.ts";
import { stripHtmlToText } from "./extra_endpoints.ts";

export { hasRemoteShards, loadShardMap };

export type FederatedListInput = {
    rest: Record<string, string | undefined>;
    limit: number;
    offset?: number;
    cursor?: string;
    withCount: boolean;
};

const remoteAccountIds = (map: ShardMap): string[] => uniqueStrings(Object.keys(map.accounts));

export const excludeRemoteSql = (map: ShardMap): { sql: string; params: string[] } => {
    const ids = remoteAccountIds(map);
    if (ids.length === 0) return { sql: "1=1", params: [] };
    return {
        sql: `(source = 'cf_routing' OR account_id IS NULL OR account_id NOT IN (SELECT value FROM json_each(?)))`,
        params: [JSON.stringify(ids)],
    };
};

const skipRemoteForFilter = (rest: Record<string, string | undefined>): boolean => {
    if (rest.domain) return true;
    return (rest.source || "").trim().toLowerCase() === "cf_routing";
};

const requestedAccounts = (rest: Record<string, string | undefined>): string[] | null => {
    if (!rest.account_id) return null;
    return uniqueStrings(rest.account_id.split(","));
};

export type FederationScope = { account_ids: string[] | null; sources: string[] | null };

const scopedRest = (
    c: Context<HonoCustomType>,
    rest: Record<string, string | undefined>,
): Record<string, string | undefined> => {
    const key = c.get("apiKey");
    return key && !c.get("unifiedUserAuth") ? scopeQuery(key, rest) : rest;
};

const listOwnedAccountIds = async (c: Context<HonoCustomType>): Promise<string[] | null> => {
    const userAuth = c.get("unifiedUserAuth");
    if (userAuth?.isAdmin) return null;
    const userId = userAuth?.userPayload?.user_id;
    if (userId) {
        const { results } = await c.env.DB.prepare(
            `SELECT id FROM user_mail_accounts WHERE user_id = ?`,
        ).bind(userId).all<{ id: string }>();
        return (results || []).map((row) => row.id);
    }
    const key = c.get("apiKey");
    if (!key) return [];
    if (key.role === "admin") return null;
    const accounts = scopeQuery(key, {}).account_id;
    return accounts ? uniqueStrings(accounts.split(",")) : null;
};

type ScopedTarget = { shard: ShardEndpoint; scope: FederationScope };

/** Group once by active owner; idle shards and stale copies are never queried. */
const scopedTargets = (
    map: ShardMap, rest: Record<string, string | undefined>, owned: string[] | null,
): ScopedTarget[] => {
    const requested = requestedAccounts(rest);
    const requestedSet = requested ? new Set(requested) : null;
    const candidates = owned ?? requested ?? Object.keys(map.accounts);
    const grouped = new Map<string, string[]>();
    for (const id of candidates) {
        if (!Object.hasOwn(map.accounts, id) || (requestedSet && !requestedSet.has(id))) continue;
        const owner = map.accounts[id];
        const ids = grouped.get(owner);
        if (ids) ids.push(id);
        else grouped.set(owner, [id]);
    }
    const sources = rest.source ? uniqueStrings(rest.source.split(",")) : null;
    const targets: ScopedTarget[] = [];
    for (const shard of map.shards) {
        const ids = grouped.get(shard.id);
        if (ids?.length) targets.push({ shard, scope: { account_ids: ids, sources } });
    }
    return targets;
};

const requestLimits = (c: Context<HonoCustomType>, maxBodyBytes: number): ShardFetchOptions => ({
    deadlineAtMs: performance.now() + SHARD_FETCH_TIMEOUT_MS,
    signal: c.req.raw?.signal,
    responseBudget: createShardResponseBudget(),
    maxBodyBytes,
});

type RemoteList = { results?: UnifiedListRow[]; count?: number | null; has_more?: boolean; next_cursor?: string | null };
const MAX_REMOTE_LIST_CALLS = 24;

const localList = async (
    c: Context<HonoCustomType>,
    map: ShardMap,
    input: FederatedListInput,
    fetchLimit: number,
) => {
    const scoped = boundedEmailFilter(await resolveScopedEmailFilter(c, input.rest));
    const exclude = excludeRemoteSql(map);
    const where = `(${scoped.where}) AND ${exclude.sql}`;
    const params = [...scoped.params, ...exclude.params];
    if (input.offset !== undefined) {
        return executeUnboundedOffsetList(c, {
            where,
            params,
            limit: fetchLimit,
            offset: 0,
            withCount: input.withCount,
            orderBy: UNIFIED_EMAIL_ORDER,
        });
    }
    return executeCursorList(c, {
        where,
        params,
        limit: fetchLimit,
        cursor: input.cursor,
        withCount: input.withCount,
    });
};

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
const remoteListPages = async (
    targets: ScopedTarget[], input: FederatedListInput, local: MergeEmailRow[],
    needed: number, limits: ShardFetchOptions,
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
                    with_count: input.withCount && state.rows.length === 0 ? 1 : 0,
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

/** Remote-map list. Caller must have already confirmed hasRemoteShards(map). */
export const federatedListEmails = async (
    c: Context<HonoCustomType>,
    map: ShardMap,
    input: FederatedListInput,
): Promise<Response> => {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
        return c.json({ error: "invalid limit" }, 400);
    }
    if (input.offset !== undefined && (!Number.isInteger(input.offset) || input.offset < 0)) {
        return c.json({ error: "invalid offset" }, 400);
    }
    if (input.offset !== undefined && input.offset > MAX_UNIFIED_OFFSET) {
        return c.json({ error: "offset exceeds 500; use cursor pagination" }, 400);
    }
    const limits = requestLimits(c, SHARD_LIST_MAX_BYTES);
    input = { ...input, rest: scopedRest(c, input.rest) };

    const fetchLimit = input.offset !== undefined ? input.offset + input.limit : input.limit + 1;
    let local;
    try {
        local = await localList(c, map, input, fetchLimit);
    } catch (error) {
        if (error instanceof Error && error.message === "invalid cursor") {
            return c.json({ error: "invalid cursor" }, 400);
        }
        throw error;
    }

    const degraded: string[] = [];
    const pages: MergeEmailRow[][] = [local.results];
    const counts: (number | null)[] = [local.count];

    let unavailable: string[] = [];
    if (!skipRemoteForFilter(input.rest)) {
        const owned = await listOwnedAccountIds(c);
        const remote = await remoteListPages(scopedTargets(map, input.rest, owned), input, local.results, fetchLimit, limits);
        pages.push(...remote.pages);
        counts.push(...remote.counts);
        degraded.push(...remote.degraded);
        unavailable = remote.unavailable;
    }

    const keep = input.offset !== undefined ? input.limit : input.limit + 1;
    const merged = mergeSortedEmailPages(pages, keep, input.offset ?? 0);
    const hasMore = input.offset !== undefined ? merged.length >= input.limit : merged.length > input.limit;
    const page = merged.slice(0, input.limit);
    let nextCursor: string | null = null;
    if (input.offset === undefined && hasMore && page.length > 0) {
        const last = page[page.length - 1];
        nextCursor = encodeEmailCursor(Number(last.received_at), last.id);
    }

    // A partial merge is not a complete snapshot. Never publish a total derived
    // from only the healthy owners, and never let a cursor cross an unavailable
    // owner boundary: the caller must retry this exact page after recovery.
    const incomplete = degraded.length > 0;
    // 没要总数就一律 null，让客户端能区分「没算」和「真的是 0」。
    // 翻了页（cursor / offset>0）即使要总数也不会重算，沿用 0，与单库路径一致。
    const pageCount = (): number | null => {
        if (!input.withCount) return null;
        const paged = Boolean(input.cursor) || (input.offset !== undefined && input.offset > 0);
        return paged ? 0 : mergeCounts(counts) ?? 0;
    };
    const count = incomplete ? null : pageCount();

    const body: Record<string, unknown> = { results: page, count, incomplete, unavailable_mailbox_ids: unavailable };
    if (input.offset === undefined) {
        body.next_cursor = incomplete ? null : nextCursor;
        // Keep the boundary retryable without claiming that the partial page is
        // the end of the global stream.
        body.has_more = incomplete ? true : hasMore;
    }
    if (incomplete) body.degraded = degraded;
    return c.json(body);
};

type ScopedShardResult = {
    shard_id: string;
    status: number;
    data: Record<string, unknown> | null;
};

const scopedResult = (result: ShardCallResult<Record<string, unknown>>): ScopedShardResult => {
    if (!result.ok || Array.isArray(result.data)) return { shard_id: result.shard_id, status: 503, data: null };
    return { shard_id: result.shard_id, status: result.status ?? 200, data: result.data };
};
const scopedRequest = (
    target: ScopedTarget, path: string, init: { method?: string; body?: unknown },
): ShardRequest => ({
    shard: target.shard, path,
    init: { ...init, scope: target.scope, acceptedStatuses: [400, 403, 404, 409] },
});
const fetchScopedShards = async (
    targets: ScopedTarget[], path: string, init: { method?: string; body?: unknown }, limits: ShardFetchOptions,
): Promise<ScopedShardResult[]> => (await fanOutShardRequests<Record<string, unknown>>(
    targets.map(target => scopedRequest(target, path, init)), limits,
)).map(scopedResult);

const scopedSingleFanOut = async (
    c: Context<HonoCustomType>,
    map: ShardMap,
    path: string,
    init: { method?: string; body?: unknown },
): Promise<Response> => {
    const limits = requestLimits(c, SHARD_DETAIL_MAX_BYTES);
    const owned = await listOwnedAccountIds(c);
    // Query source/account restrictions may narrow access, never replace key scope.
    const rest = scopedRest(c, {});
    const results = await fetchScopedShards(scopedTargets(map, rest, owned), path, init, limits);
    const degraded = results.filter((result) =>
        result.status >= 500 || ![200, 202, 400, 403, 404, 409].includes(result.status))
        .map((result) => result.shard_id);
    for (const result of results) {
        if (result.status >= 200 && result.status < 300 && result.data) {
            return c.json(withDegraded(result.data, degraded), result.status === 202 ? 202 : 200);
        }
    }
    const rejected = results.find((result) => [400, 403, 409].includes(result.status));
    if (rejected?.data) {
        return c.json(withDegraded(rejected.data, degraded), rejected.status as 400 | 403 | 409);
    }
    if (degraded.length) return c.json({ error: "shard unavailable", degraded }, 503);
    return c.json({ error: "not found" }, 404);
};

export const fanOutGet = (
    c: Context<HonoCustomType>,
    map: ShardMap,
    path: string,
): Promise<Response> => scopedSingleFanOut(c, map, path, {});

export type RemoteEmailLocation = {
    shard: ShardEndpoint | null;
    emailId: string;
    accountId: string | null;
    degraded: string[];
    duplicate: boolean;
    rejected: ScopedShardResult | null;
    primary: boolean;
    /** The locator and its single mutation consume one interaction budget. */
    limits: ShardFetchOptions;
};

const authoritativeEmailResult = (
    result: ScopedShardResult, target: ScopedTarget, map: ShardMap, emailId: string,
): ScopedShardResult => {
    if (result.status < 200 || result.status >= 300) return result;
    const row = result.data;
    if (!row || row.id !== emailId || typeof row.account_id !== "string" || typeof row.source !== "string") {
        return { shard_id: result.shard_id, status: 503, data: null };
    }
    // A readable migration copy is still not an owner. UUID equality alone is
    // insufficient; active mailbox ownership and the native-mail boundary win.
    if (row.source === "cf_routing" || !Object.hasOwn(map.accounts, row.account_id)
        || map.accounts[row.account_id] !== target.shard.id) {
        return { shard_id: result.shard_id, status: 404, data: null };
    }
    const allowed = new Set(target.scope.account_ids);
    if (!allowed.has(row.account_id) || (target.scope.sources && !target.scope.sources.includes(row.source))) {
        return { shard_id: result.shard_id, status: 403, data: { error: "forbidden" } };
    }
    return result;
};

/**
 * Preflight all mapped owners before a mutation. A shard outage is not allowed
 * to turn an unknown owner into a primary write, and duplicate owners fail closed.
 */
export const locateRemoteEmailOwner = async (
    c: Context<HonoCustomType>,
    map: ShardMap,
    emailPath: string,
): Promise<RemoteEmailLocation> => {
    const emailId = c.req.param("id") ?? "";
    const limits = requestLimits(c, SHARD_DETAIL_MAX_BYTES);
    if (!emailId || emailPath !== `/shard/emails/${encodeURIComponent(emailId)}`) {
        return { shard: null, emailId, accountId: null, limits, degraded: [], duplicate: false, primary: false,
            rejected: { shard_id: "primary", status: 400, data: { error: "invalid email id" } } };
    }
    const owned = await listOwnedAccountIds(c);
    const rest = scopedRest(c, {});
    const exclude = excludeRemoteSql(map);
    const primaryRow = await c.env.DB.prepare(
        `SELECT source, account_id, to_addr FROM emails WHERE id = ? AND ${exclude.sql}`,
    ).bind(emailId, ...exclude.params).first<{ source?: string | null; account_id?: string | null; to_addr?: string | null }>();
    if (primaryRow) return { shard: null, emailId, accountId: null, limits, degraded: [], duplicate: false, rejected: null, primary: true };
    const targets = scopedTargets(map, rest, owned);
    const fetched = await fetchScopedShards(targets, emailPath, {}, limits);
    const results = fetched.map((result, index) => ({
        shard: targets[index].shard,
        result: authoritativeEmailResult(result, targets[index], map, emailId),
    }));
    const degraded = results.filter(({ result }) => result.status >= 500).map(({ shard }) => shard.id);
    const hits = results.filter(({ result }) => result.status >= 200 && result.status < 300);
    // An unrelated shard may reject an orphan copy because its scope excludes
    // that mailbox. A validated owner hit already proves row authorization.
    const rejected = hits.length ? null : results.find(({ result }) => [400, 403, 409].includes(result.status))?.result ?? null;
    const hit = hits.length === 1 ? hits[0] : null;
    const accountId = hit?.result.data?.account_id;
    return { shard: hit?.shard ?? null, emailId, accountId: typeof accountId === "string" ? accountId : null,
        limits, degraded, duplicate: hits.length > 1, rejected, primary: false };
};

export const applyToShard = async (
    c: Context<HonoCustomType>,
    map: ShardMap,
    shard: ShardEndpoint,
    path: string,
    init: { method?: string; body?: unknown },
    location: RemoteEmailLocation,
): Promise<Response> => {
    const match = /^\/shard\/emails\/([^/]+)(?:\/(?:read|unread|star|move))?$/.exec(path);
    const expectedPath = `/shard/emails/${encodeURIComponent(location.emailId)}`;
    if (!match || (path !== expectedPath && !path.startsWith(`${expectedPath}/`))
        || location.shard?.id !== shard.id || !location.accountId || location.duplicate || location.degraded.length
        || map.accounts[location.accountId] !== shard.id) {
        return c.json({ error: "email owner changed" }, 409);
    }
    const limits = location.limits;
    const owned = await listOwnedAccountIds(c);
    const rest = scopedRest(c, {});
    const target = scopedTargets(map, rest, owned).find(target => target.shard.id === shard.id);
    if (!target || !target.scope.account_ids?.includes(location.accountId)) return c.json({ error: "forbidden" }, 403);
    // Re-read permissions, then bind the write to this exact mailbox. A changed
    // row on the same shard cannot broaden the authorization from the locator.
    const request = scopedRequest({ ...target, scope: { ...target.scope, account_ids: [location.accountId] } }, path, init);
    const result = scopedResult(await fetchShardJson<Record<string, unknown>>(shard, path, { ...limits, ...request.init }));
    if (result.status >= 200 && result.status < 300 && result.data) return c.json(result.data, result.status as 200 | 202);
    if ([400, 403, 404, 409].includes(result.status) && result.data) return c.json(result.data, result.status as 400 | 403 | 404 | 409);
    return c.json({ error: "shard unavailable", degraded: [shard.id] }, 503);
};

const localScopedWhere = async (
    c: Context<HonoCustomType>,
    map: ShardMap,
    rest: Record<string, string | undefined>,
) => {
    const scoped = boundedEmailFilter(await resolveScopedEmailFilter(c, rest));
    const exclude = excludeRemoteSql(map);
    return {
        where: `(${scoped.where}) AND ${exclude.sql}`,
        params: [...scoped.params, ...exclude.params],
    };
};

const queryStringForShard = (
    rest: Record<string, string | undefined>,
    accountIds: string[] | null,
): string => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(rest)) {
        if (value == null || value === "" || key === "account_id") continue;
        qs.set(key, value);
    }
    if (accountIds) qs.set("account_id", accountIds.join(","));
    const encoded = qs.toString();
    return encoded ? `?${encoded}` : "";
};

type FanOutOk<T> = { ok: true; shard_id: string; data: T };

const fanOutExtra = async <T>(
    c: Context<HonoCustomType>,
    map: ShardMap,
    path: string,
    rest: Record<string, string | undefined>,
    limits: ShardFetchOptions,
): Promise<{ results: FanOutOk<T>[]; degraded: string[] }> => {
    const degraded: string[] = [];
    const results: FanOutOk<T>[] = [];
    rest = scopedRest(c, rest);
    if (skipRemoteForFilter(rest)) return { results, degraded };
    const owned = await listOwnedAccountIds(c);
    const remote = await fanOutShardRequests<T>(scopedTargets(map, rest, owned).map(target => ({
        shard: target.shard, path: `${path}${queryStringForShard(rest, null)}`, init: { scope: target.scope },
    })), limits);
    for (const result of remote) {
        if (!result.ok) {
            degraded.push(result.shard_id);
            continue;
        }
        if (result.data == null) continue;
        results.push(result as FanOutOk<T>);
    }
    return { results, degraded };
};

const withDegraded = (body: Record<string, unknown>, degraded: string[]): Record<string, unknown> => {
    if (degraded.length) body.degraded = degraded;
    return body;
};

export const federatedCount = async (
    c: Context<HonoCustomType>,
    map: ShardMap,
): Promise<Response> => {
    const limits = requestLimits(c, SHARD_LIST_MAX_BYTES);
    const rest = c.req.query();
    const scoped = await localScopedWhere(c, map, rest);
    const localCount = await c.env.DB.prepare(`SELECT count(*) as count FROM emails WHERE ${scoped.where}`)
        .bind(...scoped.params).first("count");
    const { results, degraded } = await fanOutExtra<{ count?: number }>(c, map, "/shard/count", rest, limits);
    const count = mergeCounts([
        Number(localCount || 0),
        ...results.map((result) => result.data.count ?? 0),
    ]) ?? 0;
    return c.json(withDegraded({ count }, degraded));
};

export const federatedStats = async (
    c: Context<HonoCustomType>,
    map: ShardMap,
): Promise<Response> => {
    const limits = requestLimits(c, SHARD_LIST_MAX_BYTES);
    const rest = c.req.query();
    const scoped = await localScopedWhere(c, map, rest);
    const local = await c.env.DB.prepare(
        `SELECT count(*) as count,
                COALESCE(SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END), 0) as unread
         FROM emails WHERE ${scoped.where}`,
    ).bind(...scoped.params).first() as { count?: number | string; unread?: number | string } | null;
    const { results, degraded } = await fanOutExtra<{ count?: number; unread?: number }>(c, map, "/shard/stats", rest, limits);
    let count = Number(local?.count || 0);
    let unread = Number(local?.unread || 0);
    for (const result of results) {
        count += Number(result.data.count || 0);
        unread += Number(result.data.unread || 0);
    }
    return c.json(withDegraded({ count, unread }, degraded));
};

type VerifRow = {
    from_addr?: unknown;
    to_addr?: unknown;
    subject?: unknown;
    received_at?: unknown;
    code?: unknown;
};

export const federatedVerifCodes = async (
    c: Context<HonoCustomType>,
    map: ShardMap,
): Promise<Response> => {
    const limits = requestLimits(c, SHARD_LIST_MAX_BYTES);
    const q = c.req.query();
    const addr = typeof q.addr === "string" ? q.addr.trim() : "";
    const scoped = await localScopedWhere(c, map, { ...q, addr: undefined });
    let freshMs = 10 * 60 * 1000;
    if (q.fresh !== undefined) {
        const n = Number(q.fresh);
        if (!Number.isFinite(n) || n < 0) return c.json({ error: "invalid fresh" }, 400);
        freshMs = n;
    }
    if (freshMs > 0 && freshMs < 10000) freshMs = freshMs * 60 * 1000;
    const since = Date.now() - freshMs;
    const { results: localRows } = await c.env.DB.prepare(
        `SELECT subject, text_body,
                CASE WHEN (text_body IS NULL OR trim(text_body) = '')
                     THEN substr(html_body, 1, 8000)
                     ELSE '' END AS html_body,
                from_addr, to_addr, received_at FROM emails
         WHERE ${scoped.where}${addr ? " AND to_addr = ?" : ""} AND received_at >= ? ORDER BY received_at DESC LIMIT 50`,
    ).bind(...scoped.params, ...(addr ? [addr] : []), since).all();
    const localOut = (localRows as Record<string, unknown>[]).map((row) => {
        const text = (typeof row.text_body === "string" && row.text_body.trim())
            ? row.text_body
            : stripHtmlToText(typeof row.html_body === "string" ? row.html_body : "");
        return {
            from_addr: row.from_addr,
            to_addr: row.to_addr,
            subject: row.subject,
            received_at: row.received_at,
            code: extractVerifCode(`${row.subject ?? ""}\n${text}`),
        };
    }).filter((row) => row.code);

    const { results, degraded } = await fanOutExtra<{ results?: VerifRow[] }>(c, map, "/shard/verifcodes", q, limits);
    const merged: VerifRow[] = [...localOut];
    for (const result of results) merged.push(...(result.data.results || []));
    merged.sort((a, b) => Number(b.received_at || 0) - Number(a.received_at || 0));
    const seen = new Set<string>();
    const out: VerifRow[] = [];
    for (const row of merged) {
        if (!row.code) continue;
        const key = `${row.to_addr}|${row.received_at}|${row.code}|${row.from_addr}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(row);
        if (out.length >= 50) break;
    }
    return c.json(withDegraded({ results: out }, degraded));
};

export const federatedMeta = async (
    c: Context<HonoCustomType>,
    map: ShardMap,
): Promise<Response> => {
    const limits = requestLimits(c, SHARD_LIST_MAX_BYTES);
    const scoped = await localScopedWhere(c, map, {});
    const [sourceRes, accountRes, toAddrRes] = await Promise.all([
        c.env.DB.prepare(`SELECT DISTINCT source FROM emails WHERE ${scoped.where} AND source IS NOT NULL LIMIT 50`).bind(...scoped.params).all<{ source: string }>(),
        c.env.DB.prepare(`SELECT DISTINCT account_id FROM emails WHERE ${scoped.where} AND account_id IS NOT NULL LIMIT 100`).bind(...scoped.params).all<{ account_id: string }>(),
        c.env.DB.prepare(`SELECT DISTINCT to_addr FROM emails WHERE ${scoped.where} AND to_addr IS NOT NULL LIMIT 200`).bind(...scoped.params).all<{ to_addr: string }>(),
    ]);
    const { results, degraded } = await fanOutExtra<{
        sources?: string[];
        accounts?: string[];
        to_addrs?: string[];
    }>(c, map, "/shard/meta", {}, limits);
    return c.json(withDegraded({
        sources: mergeStringSets([
            (sourceRes.results || []).map((row) => row.source),
            ...results.map((result) => result.data.sources),
        ], 50),
        accounts: mergeStringSets([
            (accountRes.results || []).map((row) => row.account_id),
            ...results.map((result) => result.data.accounts),
        ], 100),
        to_addrs: mergeStringSets([
            (toAddrRes.results || []).map((row) => row.to_addr),
            ...results.map((result) => result.data.to_addrs),
        ], 200),
    }, degraded));
};

export const federatedFolders = async (
    c: Context<HonoCustomType>,
    map: ShardMap,
): Promise<Response> => {
    const limits = requestLimits(c, SHARD_LIST_MAX_BYTES);
    const localRes = await listFolders(c);
    const local = await localRes.json() as { results?: Array<{ account_id?: string }>; error?: string };
    if (localRes.status !== 200) return localRes;
    const remoteIds = new Set(remoteAccountIds(map));
    const localRows = (local.results || []).filter((row) => !row.account_id || !remoteIds.has(row.account_id));
    const rest = c.req.query();
    const { results, degraded } = await fanOutExtra<{ results?: unknown[] }>(c, map, "/shard/folders", rest, limits);
    const merged = [...localRows];
    for (const result of results) merged.push(...((result.data.results || []) as typeof localRows));
    return c.json(withDegraded({ results: merged }, degraded));
};

/**
 * Keep migrated primary email copies out of the existing apply-if-exists handlers.
 * Add the predicate to their own row lookup, rather than locating an ID first and
 * routing a later mutation. The request's map snapshot and DB stay isolated.
 */
export const primaryOnlyContext = (
    c: Context<HonoCustomType>,
    map: ShardMap,
): Context<HonoCustomType> => {
    const exclude = excludeRemoteSql(map);
    const db = new Proxy(c.env.DB, {
        get(target, property) {
            if (property === "prepare") return (sql: string) => {
                // mutationEmailSelect is a multiline SELECT. Restrict rewriting
                // to its terminal email lookup so authorization, folders, writes,
                // and pre-cutover primary mutation jobs retain their semantics.
                if (/^\s*SELECT\b/i.test(sql)
                    && /\bFROM\s+emails\s+WHERE\s+id\s*=\s*\?\s*$/i.test(sql)) {
                    const statement = target.prepare(`${sql} AND ${exclude.sql}`);
                    return new Proxy(statement, {
                        get(stmt, key) {
                            if (key === "bind") return (...values: unknown[]) => stmt.bind(...values, ...exclude.params);
                            const value = Reflect.get(stmt, key);
                            return typeof value === "function" ? value.bind(stmt) : value;
                        },
                    });
                }
                return target.prepare(sql);
            };
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
    return new Proxy(c, {
        get(target, property) {
            if (property === "env") return { ...target.env, DB: db };
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
};

/** Shard-then-metadata cascade. Returns false if any mapped shard rejected the purge. */
export const purgeShardAccounts = async (
    map: ShardMap,
    accountIds: readonly string[],
): Promise<boolean> => {
    const grouped = groupAccountsByShard(map, accountIds);
    if (grouped.size === 0) return true;
    const requests: ShardRequest[] = [];
    for (const [shardId, ids] of grouped) {
        const shard = shardById(map, shardId);
        if (!shard) return false;
        requests.push({ shard, path: "/shard/accounts/purge", init: { method: "POST", body: { account_ids: ids } } });
    }
    const results = await fanOutShardRequests<{ ok?: boolean; account_ids?: unknown; deleted?: unknown }>(requests, { maxBodyBytes: SHARD_LIST_MAX_BYTES });
    return results.every((result) => {
        if (!result.ok || !result.data || result.data.ok !== true) return false;
        const ids = Array.isArray(result.data.account_ids)
            ? result.data.account_ids.filter((id): id is string => typeof id === "string")
            : [];
        const expected = grouped.get(result.shard_id) || [];
        if (ids.length !== expected.length || ids.some((id, index) => id !== expected[index])) return false;
        return Number.isSafeInteger(result.data.deleted) && Number(result.data.deleted) >= 0;
    });
};
