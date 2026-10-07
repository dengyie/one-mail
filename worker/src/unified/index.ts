import { Context, Hono } from "hono";
import { handleListQuery, commonGetUserRole } from "../common";
import { checkIsAdmin } from "../utils";
import { ingestHandler } from "./ingest";
import { countEmails, statsEmails, verifCodes, getMetaOptions } from "./extra_endpoints";
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
import { claimOutboundJobs, reportOutboundResult } from "./outbound_jobs.ts";
import { claimLegacyMutationJobs } from "./mutation_claim_legacy.ts";
import { listFolders } from "./folders.ts";
import { createKey } from "./key_admin";
import { lookupKey, canAccess } from "./api_keys";
import { resolveScopedEmailFilter, checkRowAccess } from "./auth_scope";
import { cursorPredicate, decodeEmailCursor, encodeEmailCursor } from "./cursor";
import {
    federatedListEmails,
    federatedCount,
    federatedStats,
    federatedVerifCodes,
    federatedMeta,
    federatedFolders,
    fanOutGet,
    locateRemoteEmailOwner,
    applyToShard,
    hasRemoteShards,
    loadShardMap,
    excludeRemoteSql,
    primaryOnlyContext,
} from "./federation.ts";
import { UNIFIED_EMAIL_ORDER, UNIFIED_EMAIL_SELECT } from "./unified_sql.ts";
import mail_accounts from "../user_api/mail_accounts";
import {
    DEFAULT_MAX_UNIFIED_PAGE_SIZE,
    HARD_MAX_UNIFIED_PAGE_SIZE,
    getMaxUnifiedPageSize,
} from "../quota.ts";

const api = new Hono<HonoCustomType>();

// 多通道鉴权：
//  1) x-user-token（用户登录，浏览器 UI 主路径）：解析 userPayload，按 ADMIN_USER_ROLE
//     判定管理员；普通用户的租户边界在 SQL 中按 account/address ownership 强制执行。
//     若普通用户同时携带了有效 x-admin-auth 管理密码，同等赋予管理员全域权限。
//  2) x-admin-auth（管理密码直接鉴权）：供管理面板与控制台直接访问全域视图。
//  3) Authorization: Bearer <api-key>（程序化访问）：lookupKey + source/account 白名单。
// 均不满足 → 401。
api.use("/api/unified/*", async (c, next) => {
    const userToken = c.req.raw.headers.get("x-user-token");
    if (userToken) {
        // worker.ts has already verified the signature, expiry, and the
        // user_id + user_email identity binding before this route runs.
        const payload = c.get("userPayload") as UserPayload | undefined;
        if (!payload || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
            return c.json({ error: "invalid user token" }, 401);
        }
        try {
            // 角色只查一次并放入上下文：权限和资源配额必须使用同一事实来源。
            // 不再预取用户所有地址/邮箱账号，避免随着租户资源增加构造越来越大的 IN 列表。
            const userRole = (await commonGetUserRole(c, payload.user_id))?.role ?? null;
            let isAdmin = !!c.env.ADMIN_USER_ROLE && userRole === c.env.ADMIN_USER_ROLE;
            if (!isAdmin && (await checkIsAdmin(c))) {
                isAdmin = true;
            }
            c.set("unifiedUserAuth", { userPayload: payload, isAdmin, userRole });
            await next();
            return;
        } catch {
            return c.json({ error: "invalid user token" }, 401);
        }
    }

    // 回退：x-admin-auth 管理密码通道（管理员后台/运维直接凭管理密码访问统一收件箱与域名邮箱）
    if (await checkIsAdmin(c)) {
        c.set("unifiedUserAuth", {
            userPayload: null,
            isAdmin: true,
            userRole: c.env.ADMIN_USER_ROLE || "admin",
        });
        await next();
        return;
    }

    // 回退：Bearer API-key
    const auth = c.req.raw.headers.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return c.json({ error: "missing bearer token or login" }, 401);
    const keyRow = await lookupKey(c.env, token);
    if (!keyRow) return c.json({ error: "invalid api key" }, 401);
    // 校验 method + 用户显式传入的 source/account_id 是否在白名单内
    const q = c.req.query();
    if (!canAccess(keyRow, c.req.method, q.source, q.account_id)) {
        return c.json({ error: "forbidden" }, 403);
    }
    c.set("apiKey", keyRow);
    await next();
});

const getUnifiedPageQuota = async (c: Context<HonoCustomType>): Promise<number> => {
    const userAuth = c.get("unifiedUserAuth");
    if (userAuth) {
        return getMaxUnifiedPageSize(c, userAuth.userRole);
    }
    // API key 没有用户 role：admin key 使用 Worker 硬上限，readonly key 使用普通用户默认值。
    return c.get("apiKey")?.role === "admin"
        ? HARD_MAX_UNIFIED_PAGE_SIZE
        : DEFAULT_MAX_UNIFIED_PAGE_SIZE;
};

type UnifiedListRow = {
    id: string;
    received_at: number;
    [key: string]: unknown;
};

export const listEmails = async (c: Context<HonoCustomType>) => {
    const { limit, offset, cursor, with_count, ...rest } = c.req.query();
    // with_count=0 供轮询探测使用：跳过 COUNT(*)，避免每次刷新都全量扫描过滤集。
    const withCount = with_count !== "0";
    const requestedLimit = typeof limit === "string" ? parseInt(limit, 10) : Number(limit);
    const maxPageSize = await getUnifiedPageQuota(c);
    if (Number.isFinite(requestedLimit) && requestedLimit > maxPageSize) {
        return c.json({
            error: "quota_exceeded",
            quota: "maxUnifiedPageSize",
            limit: maxPageSize,
        }, 400);
    }

    if (cursor && offset !== undefined) {
        return c.json({ error: "cursor and offset are mutually exclusive" }, 400);
    }

    const map = await loadShardMap(c.env);
    if (hasRemoteShards(map)) {
        if (!Number.isInteger(requestedLimit) || requestedLimit <= 0) {
            return c.json({ error: "invalid limit" }, 400);
        }
        const requestedOffset = offset === undefined ? undefined : Number(offset);
        if (requestedOffset !== undefined && (!Number.isInteger(requestedOffset) || requestedOffset < 0)) {
            return c.json({ error: "invalid offset" }, 400);
        }
        return federatedListEmails(c, map, {
            rest,
            limit: requestedLimit,
            offset: requestedOffset,
            cursor,
            withCount,
        });
    }

    const { where, params } = await resolveScopedEmailFilter(c, rest);

    // Explicit offset keeps the legacy response/query contract for existing
    // integrations. When offset is omitted, cursor mode is the default path.
    if (offset !== undefined) {
        return handleListQuery(c,
            `${UNIFIED_EMAIL_SELECT} WHERE ${where}`,
            `SELECT count(*) as count FROM emails WHERE ${where}`,
            params as string[], limit, offset, UNIFIED_EMAIL_ORDER, [], { skipCount: !withCount });
    }

    if (!Number.isInteger(requestedLimit) || requestedLimit <= 0 || requestedLimit > HARD_MAX_UNIFIED_PAGE_SIZE) {
        return c.json({ error: "invalid limit" }, 400);
    }

    let decodedCursor: ReturnType<typeof decodeEmailCursor> | null = null;
    if (cursor) {
        try {
            decodedCursor = decodeEmailCursor(cursor);
        } catch {
            return c.json({ error: "invalid cursor" }, 400);
        }
    }

    let pageWhere = where;
    const pageParams: (string | number)[] = [...params];
    if (decodedCursor) {
        const predicate = cursorPredicate(decodedCursor);
        pageWhere = `(${where}) AND ${predicate.sql}`;
        pageParams.push(...predicate.params);
    }

    // Fetch one extra row to determine has_more without a second scan. The
    // cursor predicate matches idx_emails_*_order_cursor from Phase 1.
    const { results } = await c.env.DB.prepare(
        `${UNIFIED_EMAIL_SELECT} WHERE ${pageWhere} ORDER BY ${UNIFIED_EMAIL_ORDER} LIMIT ?`,
    ).bind(...pageParams, requestedLimit + 1).all<UnifiedListRow>();

    const hasMore = results.length > requestedLimit;
    const page = results.slice(0, requestedLimit);
    let nextCursor: string | null = null;
    if (hasMore && page.length > 0) {
        const last = page[page.length - 1];
        const sortKey = Number(last.received_at);
        if (!Number.isSafeInteger(sortKey) || typeof last.id !== "string" || !last.id) {
            throw new Error("invalid email sort identity");
        }
        nextCursor = encodeEmailCursor(sortKey, last.id);
    }

    // Preserve the old first-page count behavior so clients can show totals,
    // but never repeat the full COUNT scan for later cursor pages.
    const count = decodedCursor
        ? 0
        : withCount
            ? await c.env.DB.prepare(`SELECT count(*) as count FROM emails WHERE ${where}`)
                .bind(...params).first<number>("count")
            : null;

    return c.json({
        results: page,
        count: count ?? 0,
        next_cursor: nextCursor,
        has_more: hasMore,
    });
};

const getEmail = async (c: Context<HonoCustomType>) => {
    const map = await loadShardMap(c.env);
    const exclude = excludeRemoteSql(map);
    const row = await c.env.DB.prepare(`SELECT * FROM emails WHERE id = ? AND ${exclude.sql}`)
        .bind(c.req.param("id"), ...exclude.params).first() as { source?: string | null; account_id?: string | null; to_addr?: string | null } | null;
    if (row) {
        if (!(await checkRowAccess(c, row))) {
            return c.json({ error: "forbidden" }, 403);
        }
        return c.json(row);
    }
    if (!hasRemoteShards(map)) return c.json({ error: "not found" }, 404);
    return fanOutGet(c, map, `/shard/emails/${encodeURIComponent(c.req.param("id") || "")}`);
};

const applyIfExists = async (
    c: Context<HonoCustomType>,
    local: (c: Context<HonoCustomType>) => Promise<Response>,
    method: string,
    shardPath: string,
) => {
    const map = await loadShardMap(c.env);
    if (!hasRemoteShards(map)) return local(c);
    const rawClone = c.req.raw.clone();
    const body = method === "DELETE" ? undefined : await rawClone.json().catch(() => undefined);
    // Probe every eligible owner first. Only after the complete owner set is
    // known do we dispatch one mutation, so no remote commit can be followed by
    // a local primary commit or an overall failure response.
    const owner = await locateRemoteEmailOwner(c, map, `/shard/emails/${encodeURIComponent(c.req.param("id") || "")}`);
    if (owner.duplicate) return c.json({ error: "duplicate email owners" }, 409);
    if (owner.degraded.length) return c.json({ error: "shard unavailable", degraded: owner.degraded }, 503);
    if (owner.rejected?.data) return c.json(owner.rejected.data, owner.rejected.status as 400 | 403 | 409);
    if (owner.shard) return applyToShard(c, map, owner.shard, shardPath, { method, body }, owner);
    if (!owner.primary && !owner.degraded.length) {
        return c.json({ error: "not found" }, 404);
    }
    return local(primaryOnlyContext(c, map));
};

api.get("/api/unified/emails", listEmails);
api.get("/api/unified/meta", async (c) => {
    const map = await loadShardMap(c.env);
    if (!hasRemoteShards(map)) return getMetaOptions(c);
    return federatedMeta(c, map);
});
api.get("/api/unified/folders", async (c) => {
    const map = await loadShardMap(c.env);
    if (!hasRemoteShards(map)) return listFolders(c);
    return federatedFolders(c, map);
});
api.get("/api/unified/emails/:id", getEmail);
api.get("/api/unified/count", async (c) => {
    const map = await loadShardMap(c.env);
    if (!hasRemoteShards(map)) return countEmails(c);
    return federatedCount(c, map);
});
api.get("/api/unified/stats", async (c) => {
    const map = await loadShardMap(c.env);
    if (!hasRemoteShards(map)) return statsEmails(c);
    return federatedStats(c, map);
});
api.get("/api/unified/verifcodes", async (c) => {
    const map = await loadShardMap(c.env);
    if (!hasRemoteShards(map)) return verifCodes(c);
    return federatedVerifCodes(c, map);
});
api.get("/api/unified/mutations/:id", async (c) => {
    const map = await loadShardMap(c.env);
    if (!hasRemoteShards(map)) return getMutationStatus(c);
    // Jobs remain on the queue where they were created, including pre-cutover
    // primary jobs for mapped accounts. Only email copies are excluded.
    const local = await getMutationStatus(c);
    if (local.status !== 404) return local;
    return fanOutGet(c, map, `/shard/mutations/${encodeURIComponent(c.req.param("id") || "")}`);
});
api.post("/api/unified/emails/:id/read", (c) => applyIfExists(c, markRead, "POST", `/shard/emails/${encodeURIComponent(c.req.param("id") || "")}/read`));
api.post("/api/unified/emails/:id/unread", (c) => applyIfExists(c, markUnread, "POST", `/shard/emails/${encodeURIComponent(c.req.param("id") || "")}/unread`));
api.post("/api/unified/emails/:id/star", (c) => applyIfExists(c, toggleStar, "POST", `/shard/emails/${encodeURIComponent(c.req.param("id") || "")}/star`));
api.post("/api/unified/emails/:id/move", (c) => applyIfExists(c, moveEmail, "POST", `/shard/emails/${encodeURIComponent(c.req.param("id") || "")}/move`));
api.delete("/api/unified/emails/:id", (c) => applyIfExists(c, deleteEmail, "DELETE", `/shard/emails/${encodeURIComponent(c.req.param("id") || "")}`));
api.post("/admin/unified/ingest", ingestHandler);
api.get("/admin/unified/mail_accounts", mail_accounts.exportForAggregator);  // x-admin-auth 保护
api.post("/admin/unified/mail_accounts/:id/status", mail_accounts.reportStatus);  // 聚合器 sync 回写
api.post("/admin/unified/mail_accounts/:id/refresh_token", mail_accounts.reportRefreshToken);  // 聚合器 RT 轮换回写
api.post("/admin/unified/mail_accounts/:id/can_send", mail_accounts.setCanSend);  // 管理员发送开关（x-admin-auth）
// v1 is intentionally read/star-only for old aggregators during rolling deploys.
api.post("/admin/unified/mutations/claim", claimLegacyMutationJobs);
// v2 may lease move/delete and is used by the current aggregator.
api.post("/admin/unified/mutations/v2/claim", claimMutationJobs);
api.post("/admin/unified/mutations/:id/result", reportMutationResult); // 聚合器回写 provider 结果
// External-account outbound send queue (aggregator SMTP/OAuth adapters).
api.post("/admin/unified/outbound/claim", claimOutboundJobs);
api.post("/admin/unified/outbound/:id/result", reportOutboundResult);
// User-facing dispatch contracts live under /user_api; these admin routes are intentionally not exposed here.
api.post("/admin/unified/keys", createKey);           // x-admin-auth 保护

export default api;