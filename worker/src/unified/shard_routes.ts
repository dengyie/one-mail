import { Hono, type Context } from "hono";
import { isShardMode, resolveShardId, viewD1Quota } from "../core/d1_quota.ts";
import { authorizeShardRequest, parseShardScope, shardScopeAllowsRow } from "./shard_auth.ts";
import { resolveScopedEmailFilter } from "./auth_scope.ts";
import { canAccess } from "./api_keys.ts";
import { initializeShardSchema } from "./shard_schema.ts";
import { UNIFIED_EMAIL_ORDER } from "./unified_sql.ts";
import { executeCursorList, executeUnboundedOffsetList } from "./unified_list.ts";
import { ingestHandler } from "./ingest";
import {
    claimMutationJobs,
    deleteEmail,
    getMutationStatus,
    markRead,
    markUnread,
    moveEmail,
    reportMutationResult,
    toggleStar,
} from "./mutation_jobs";
import { claimLegacyMutationJobs } from "./mutation_claim_legacy.ts";
import { listFolders } from "./folders.ts";
import { countEmails, getMetaOptions, statsEmails, verifCodes } from "./extra_endpoints.ts";
import { chunkValues, SHARD_ACCOUNT_BIND_CHUNK } from "./shard_merge.ts";

export type ShardListDto = {
    account_ids?: unknown;
    source?: string; unread?: string; starred?: string; q?: string;
    since?: string; until?: string; to_addr?: string;
    limit?: number; offset?: number; cursor?: string; with_count?: number | string;
};
type ShardPurgeDto = { account_ids?: unknown };
const readDto = async <T extends object>(c: Context<HonoCustomType>): Promise<T | null> => {
    try {
        const value: unknown = await c.req.json();
        return value !== null && typeof value === "object" && !Array.isArray(value) ? value as T : null;
    } catch { return null; }
};
const shard = new Hono<HonoCustomType>();
// Preserve the internal cause chain without returning D1 errors or secrets to callers.
shard.onError((cause, c) => {
    console.error(new Error("Shard request failed", { cause }));
    return c.json({ error: "shard request failed" }, 500);
});

const accountWhere = (accountIds: string[] | null): { where: string; params: (string | number)[] } => {
    if (accountIds == null) return { where: "1=1", params: [] };
    if (accountIds.length === 0) return { where: "0=1", params: [] };
    // One JSON binding avoids D1's 100-parameter ceiling; OR-ing IN chunks does not.
    return { where: "account_id IN (SELECT value FROM json_each(?))", params: [JSON.stringify(accountIds)] };
};

const parseAccountIds = (value: unknown): string[] | null => {
    if (value == null) return null;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) return null;
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        if (typeof item !== "string") continue;
        const id = item.trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
    }
    return ids;
};

shard.use("/shard/*", async (c, next) => {
    if (!(await authorizeShardRequest(c.env, c.req.raw))) {
        return c.json({ error: "unauthorized" }, 401);
    }
    const scopeHeaderPresent = c.req.raw.headers.has("x-one-mail-shard-scope");
    const scope = parseShardScope(c.req.raw);
    if (scopeHeaderPresent && !scope) return c.json({ error: "invalid shard scope" }, 400);
    const rowPath = /^\/shard\/(emails|mutations)\/[^/]+(?:\/(read|unread|star|move))?$/.test(c.req.path)
        && !["/shard/mutations/claim", "/shard/mutations/v2/claim"].includes(c.req.path);
    if (rowPath && !scope) return c.json({ error: "shard scope required" }, 403);
    if (scope) {
        const key = {
            id: "gateway", name: "gateway", key_hash: "", enabled: 1,
            role: "readonly",
            allowed_accounts: scope.account_ids === null ? null : JSON.stringify(scope.account_ids),
            allowed_sources: scope.sources === null ? null : JSON.stringify(scope.sources),
        };
        // Empty whitelist means unrestricted in legacy API-key helpers: deny explicitly.
        if (scope.account_ids?.length === 0 || scope.sources?.length === 0) {
            if (rowPath) return c.json({ error: "forbidden" }, 403);
            if (c.req.path === "/shard/meta") return c.json({ sources: [], accounts: [], to_addrs: [] });
            if (c.req.path === "/shard/count") return c.json({ count: 0 });
            if (c.req.path === "/shard/stats") return c.json({ count: 0, unread: 0 });
            return c.json({ results: [], count: 0, has_more: false, next_cursor: null });
        }
        if (!canAccess(key, "GET", c.req.query("source"), c.req.query("account_id"))) {
            return c.json({ error: "forbidden" }, 403);
        }
        c.set("apiKey", key);
        // Use the immutable row/job snapshot before any mutation or response.
        if (rowPath) {
            let id: string;
            try { id = decodeURIComponent(c.req.path.split("/")[3]); }
            catch { return c.json({ error: "invalid id" }, 400); }
            const table = c.req.path.startsWith("/shard/mutations/") ? "mail_mutation_jobs" : "emails";
            const row = await c.env.DB.prepare(`SELECT source, account_id FROM ${table} WHERE id = ?`)
                .bind(id).first<{ source: string | null; account_id: string | null }>();
            if (row && !shardScopeAllowsRow(scope, row)) return c.json({ error: "forbidden" }, 403);
        }
    } else {
        c.set("unifiedUserAuth", { userPayload: null, isAdmin: true, userRole: c.env.ADMIN_USER_ROLE || "admin" });
    }
    await next();
});

shard.get("/shard/health", async (c) => c.json({
    ok: true,
    shard_id: resolveShardId(c.env),
    shard_mode: isShardMode(c.env),
}));

shard.get("/shard/quota", async (c) => c.json(await viewD1Quota(c.env)));

shard.post("/shard/schema/initialize", async (c) => {
    await initializeShardSchema(c.env.DB);
    return c.json({ ok: true });
});

shard.post("/shard/emails", async (c) => {
    const body = await readDto<ShardListDto>(c);
    if (!body) return c.json({ error: "JSON object required" }, 400);
    for (const field of ["source", "unread", "starred", "q", "since", "until", "to_addr", "cursor"] as const) {
        if (body[field] !== undefined && typeof body[field] !== "string") {
            return c.json({ error: `invalid ${field}` }, 400);
        }
    }

    const accountIds = parseAccountIds(body.account_ids);
    if (body.account_ids != null && accountIds == null) {
        return c.json({ error: "account_ids must be an array of strings" }, 400);
    }
    const owned = accountWhere(accountIds);
    const key = c.get("apiKey");
    if (key && !canAccess(key, "GET", body.source)) return c.json({ error: "forbidden" }, 403);
    const filters = await resolveScopedEmailFilter(c, {
        source: body.source,
        unread: body.unread,
        starred: body.starred,
        q: body.q,
        since: body.since,
        until: body.until,
        to_addr: body.to_addr,
    });
    const where = `(${owned.where}) AND (${filters.where})`;
    const params = [...owned.params, ...filters.params];
    const withCount = body.with_count !== 0 && body.with_count !== "0";
    const limit = body.limit;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0 || limit > 600) {
        return c.json({ error: "invalid limit" }, 400);
    }

    if (body.offset !== undefined && body.cursor) {
        return c.json({ error: "cursor and offset are mutually exclusive" }, 400);
    }

    if (body.offset !== undefined) {
        const offset = body.offset;
        if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset > 500) {
            return c.json({ error: "invalid offset" }, 400);
        }
        const result = await executeUnboundedOffsetList(c, {
            where,
            params,
            limit,
            offset,
            withCount,
            orderBy: UNIFIED_EMAIL_ORDER,
        });
        return c.json(result);
    }

    try {
        const result = await executeCursorList(c, {
            where,
            params,
            limit,
            cursor: body.cursor,
            withCount,
        });
        return c.json(result);
    } catch (error) {
        if (error instanceof Error && error.message === "invalid cursor") {
            return c.json({ error: "invalid cursor" }, 400);
        }
        throw error;
    }
});

shard.get("/shard/emails/:id", async (c) => {
    const row = await c.env.DB.prepare(`SELECT * FROM emails WHERE id = ?`)
        .bind(c.req.param("id")).first();
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(row);
});

shard.post("/shard/emails/:id/read", markRead);
shard.post("/shard/emails/:id/unread", markUnread);
shard.post("/shard/emails/:id/star", toggleStar);
shard.post("/shard/emails/:id/move", moveEmail);
shard.delete("/shard/emails/:id", deleteEmail);
shard.get("/shard/mutations/:id", getMutationStatus);
shard.get("/shard/folders", listFolders);
shard.get("/shard/count", countEmails);
shard.get("/shard/stats", statsEmails);
shard.get("/shard/verifcodes", verifCodes);
shard.get("/shard/meta", (c) => getMetaOptions(c, c.req.query()));
shard.post("/shard/ingest", ingestHandler);
shard.post("/shard/mutations/claim", claimLegacyMutationJobs);
shard.post("/shard/mutations/v2/claim", claimMutationJobs);
shard.post("/shard/mutations/:id/result", reportMutationResult);

shard.post("/shard/accounts/purge", async (c) => {
    const body = await readDto<ShardPurgeDto>(c);
    if (!body) return c.json({ error: "JSON object required" }, 400);
    const accountIds = parseAccountIds(body.account_ids);
    if (!accountIds || accountIds.length === 0) {
        return c.json({ error: "account_ids required" }, 400);
    }
    const jsonIds = JSON.stringify(accountIds);
    const results = await c.env.DB.batch([
        c.env.DB.prepare(`DELETE FROM mail_mutation_jobs WHERE account_id IN (SELECT value FROM json_each(?))`).bind(jsonIds),
        c.env.DB.prepare(`DELETE FROM mail_account_folders WHERE mail_account_id IN (SELECT value FROM json_each(?))`).bind(jsonIds),
        c.env.DB.prepare(`DELETE FROM emails WHERE account_id IN (SELECT value FROM json_each(?))`).bind(jsonIds),
        c.env.DB.prepare(`INSERT INTO mail_account_lifecycle(account_id, state, deleting_at, purged_at)
            SELECT value, 'purged', ?, ? FROM json_each(?)
            ON CONFLICT(account_id) DO UPDATE SET state = 'purged', purged_at = excluded.purged_at`).bind(Date.now(), Date.now(), jsonIds),
    ]);
    const deleted = Number((results[2]?.meta as { changes?: number } | undefined)?.changes ?? 0);
    return c.json({ ok: true, account_ids: accountIds, deleted });
});

export default shard;
