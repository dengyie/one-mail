import type { Context } from "hono";
import { fetchShardJson, SHARD_SCOPE_HEADER } from "./shard_client.ts";
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

const shardAccountFilter = (
    map: ShardMap,
    shard: ShardEndpoint,
    rest: Record<string, string | undefined>,
    owned: string[] | null,
): { skip: boolean; account_ids: string[] | null } => {
    const onShard = Object.entries(map.accounts)
        .filter(([, id]) => id === shard.id)
        .map(([accountId]) => accountId);
    let ids = onShard;
    const requested = requestedAccounts(rest);
    if (requested) {
        const reqSet = new Set(requested);
        ids = ids.filter((id) => reqSet.has(id));
    }
    if (owned) {
        const ownedSet = new Set(owned);
        ids = ids.filter((id) => ownedSet.has(id));
    }
    if (owned && ids.length === 0) return { skip: true, account_ids: [] };
    if (owned == null && !requested) return { skip: false, account_ids: null };
    if (ids.length === 0) return { skip: true, account_ids: [] };
    return { skip: false, account_ids: ids };
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

const scopeForShard = (
    shard: ShardEndpoint,
    map: ShardMap,
    owned: string[] | null,
    rest: Record<string, string | undefined>,
): FederationScope => ({
    account_ids: shardAccountFilter(map, shard, rest, owned).account_ids,
    sources: rest.source ? uniqueStrings(rest.source.split(",")) : null,
});

type RemoteList = { results?: UnifiedListRow[]; count?: number | null };

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

    if (!skipRemoteForFilter(input.rest)) {
        const owned = await listOwnedAccountIds(c);
        const remoteResults = await Promise.all(map.shards.map(async (shard) => {
            const filter = shardAccountFilter(map, shard, input.rest, owned);
            if (filter.skip) {
                return { ok: true as const, shard_id: shard.id, data: { results: [] as UnifiedListRow[], count: input.withCount ? 0 : null } };
            }
            return fetchShardJson<RemoteList>(shard, "/shard/emails", {
                method: "POST",
                scope: scopeForShard(shard, map, owned, input.rest),
                body: {
                    account_ids: filter.account_ids,
                    source: input.rest.source,
                    unread: input.rest.unread,
                    starred: input.rest.starred,
                    q: input.rest.q,
                    since: input.rest.since,
                    until: input.rest.until,
                    to_addr: input.rest.to_addr,
                    limit: fetchLimit,
                    cursor: input.offset !== undefined ? undefined : input.cursor,
                    offset: input.offset !== undefined ? 0 : undefined,
                    with_count: input.withCount ? 1 : 0,
                },
            });
        }));
        for (const result of remoteResults) {
            if (!result.ok) {
                degraded.push(result.shard_id);
                continue;
            }
            pages.push(result.data.results || []);
            counts.push(result.data.count ?? null);
        }
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
    const count = incomplete
        ? null
        : input.offset !== undefined
            ? (input.offset === 0 ? (input.withCount ? (mergeCounts(counts) ?? 0) : null) : 0)
            : (input.cursor ? 0 : (input.withCount ? (mergeCounts(counts) ?? 0) : 0));

    const body: Record<string, unknown> = { results: page, count };
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

/** Keep endpoint errors distinct from transport failures; mutation 409 is not a miss. */
const fetchScopedShard = async (
    shard: ShardEndpoint,
    path: string,
    scope: FederationScope,
    init: { method?: string; body?: unknown },
): Promise<ScopedShardResult> => {
    const url = new URL(`${shard.base_url}${path}`);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const unavailable = (): ScopedShardResult => ({ shard_id: shard.id, status: 503, data: null });
    try {
        const deadline = new Promise<ScopedShardResult>((resolve) => {
            timer = setTimeout(() => {
                controller.abort();
                if (reader) void reader.cancel().catch(() => {});
                resolve(unavailable());
            }, 3000);
        });
        const work = async (): Promise<ScopedShardResult> => {
            const response = await fetch(url.toString(), {
                method: init.method ?? "GET",
                headers: {
                    authorization: `Bearer ${shard.token}`,
                    "content-type": "application/json",
                    [SHARD_SCOPE_HEADER]: encodeURIComponent(JSON.stringify(scope)),
                },
                redirect: "error",
                body: init.body === undefined ? undefined : JSON.stringify(init.body),
                signal: controller.signal,
            });
            if (controller.signal.aborted) {
                void response.body?.cancel().catch(() => {});
                return unavailable();
            }
            const chunks: Uint8Array[] = [];
            let length = 0;
            if (response.body) {
                reader = response.body.getReader();
                while (true) {
                    const part = await reader.read();
                    if (part.done) break;
                    length += part.value.byteLength;
                    if (length > 16 * 1024 * 1024) {
                        void reader.cancel().catch(() => {});
                        return unavailable();
                    }
                    chunks.push(part.value);
                }
            }
            const bytes = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
            const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
            if (!data || typeof data !== "object" || Array.isArray(data)) return unavailable();
            return { shard_id: shard.id, status: response.status, data: data as Record<string, unknown> };
        };
        return await Promise.race([work(), deadline]);
    } catch {
        return unavailable();
    } finally {
        clearTimeout(timer);
    }
};

const scopedSingleFanOut = async (
    c: Context<HonoCustomType>,
    map: ShardMap,
    path: string,
    init: { method?: string; body?: unknown },
): Promise<Response> => {
    const owned = await listOwnedAccountIds(c);
    // Query source/account restrictions may narrow access, never replace key scope.
    const rest = scopedRest(c, {});
    const targets = map.shards.filter((shard) => !shardAccountFilter(map, shard, rest, owned).skip);
    const results = await Promise.all(targets.map((shard) =>
        fetchScopedShard(shard, path, scopeForShard(shard, map, owned, rest), init)));
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

export const fanOutApply = (
    c: Context<HonoCustomType>,
    map: ShardMap,
    path: string,
    init: { method?: string; body?: unknown },
): Promise<Response> => scopedSingleFanOut(c, map, path, init);

/**
 * Preflight all mapped owners before a mutation. A shard outage is not allowed
 * to turn an unknown owner into a primary write, and duplicate owners fail closed.
 */
export const locateRemoteEmailOwner = async (
    c: Context<HonoCustomType>,
    map: ShardMap,
    emailPath: string,
): Promise<{ shard: ShardEndpoint | null; degraded: string[]; duplicate: boolean; rejected: ScopedShardResult | null; primary: boolean }> => {
    const owned = await listOwnedAccountIds(c);
    const rest = scopedRest(c, {});
    const exclude = excludeRemoteSql(map);
    const primaryRow = await c.env.DB.prepare(
        `SELECT source, account_id, to_addr FROM emails WHERE id = ? AND ${exclude.sql}`,
    ).bind(c.req.param("id"), ...exclude.params).first<{ source?: string | null; account_id?: string | null; to_addr?: string | null }>();
    if (primaryRow) return { shard: null, degraded: [], duplicate: false, rejected: null, primary: true };
    const targets = map.shards.filter((shard) => !shardAccountFilter(map, shard, rest, owned).skip);
    const results = await Promise.all(targets.map(async (shard) => ({
        shard,
        result: await fetchScopedShard(shard, emailPath, scopeForShard(shard, map, owned, rest), {}),
    })));
    const degraded = results.filter(({ result }) => result.status >= 500).map(({ shard }) => shard.id);
    const hits = results.filter(({ result }) => result.status >= 200 && result.status < 300);
    const rejected = results.find(({ result }) => [400, 403, 409].includes(result.status))?.result ?? null;
    return { shard: hits.length === 1 ? hits[0].shard : null, degraded, duplicate: hits.length > 1, rejected, primary: !!primaryRow };
};

export const applyToShard = async (
    c: Context<HonoCustomType>,
    map: ShardMap,
    shard: ShardEndpoint,
    path: string,
    init: { method?: string; body?: unknown },
): Promise<Response> => {
    const owned = await listOwnedAccountIds(c);
    const rest = scopedRest(c, {});
    const result = await fetchScopedShard(shard, path, scopeForShard(shard, map, owned, rest), init);
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
type FanOutFail = { ok: false; shard_id: string; error: string };

const fanOutExtra = async <T>(
    c: Context<HonoCustomType>,
    map: ShardMap,
    path: string,
    rest: Record<string, string | undefined>,
): Promise<{ results: FanOutOk<T>[]; degraded: string[] }> => {
    const degraded: string[] = [];
    const results: FanOutOk<T>[] = [];
    rest = scopedRest(c, rest);
    if (skipRemoteForFilter(rest)) return { results, degraded };
    const owned = await listOwnedAccountIds(c);
    const remote = await Promise.all(map.shards.map(async (shard) => {
        const filter = shardAccountFilter(map, shard, rest, owned);
        if (filter.skip) return { ok: true as const, shard_id: shard.id, data: null as T };
        return fetchShardJson<T>(shard, `${path}${queryStringForShard(rest, null)}`, {
            scope: scopeForShard(shard, map, owned, rest),
        });
    }));
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
    const rest = c.req.query();
    const scoped = await localScopedWhere(c, map, rest);
    const localCount = await c.env.DB.prepare(`SELECT count(*) as count FROM emails WHERE ${scoped.where}`)
        .bind(...scoped.params).first("count");
    const { results, degraded } = await fanOutExtra<{ count?: number }>(c, map, "/shard/count", rest);
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
    const rest = c.req.query();
    const scoped = await localScopedWhere(c, map, rest);
    const local = await c.env.DB.prepare(
        `SELECT count(*) as count,
                COALESCE(SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END), 0) as unread
         FROM emails WHERE ${scoped.where}`,
    ).bind(...scoped.params).first() as { count?: number | string; unread?: number | string } | null;
    const { results, degraded } = await fanOutExtra<{ count?: number; unread?: number }>(c, map, "/shard/stats", rest);
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

    const { results, degraded } = await fanOutExtra<{ results?: VerifRow[] }>(c, map, "/shard/verifcodes", q);
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
    }>(c, map, "/shard/meta", {});
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
    const localRes = await listFolders(c);
    const local = await localRes.json() as { results?: Array<{ account_id?: string }>; error?: string };
    if (localRes.status !== 200) return localRes;
    const remoteIds = new Set(remoteAccountIds(map));
    const localRows = (local.results || []).filter((row) => !row.account_id || !remoteIds.has(row.account_id));
    const rest = c.req.query();
    const { results, degraded } = await fanOutExtra<{ results?: unknown[] }>(c, map, "/shard/folders", rest);
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
    const tasks: Promise<FanOutOk<{ ok?: boolean; account_ids?: unknown; deleted?: unknown }> | FanOutFail>[] = [];
    for (const [shardId, ids] of grouped) {
        const shard = shardById(map, shardId);
        if (!shard) return false;
        tasks.push(fetchShardJson(shard, "/shard/accounts/purge", {
            method: "POST",
            body: { account_ids: ids },
        }));
    }
    const results = await Promise.all(tasks);
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
