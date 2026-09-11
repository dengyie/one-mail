import { Context, Hono } from "hono";
import { handleListQuery, commonGetUserRole } from "../common";
import { ingestHandler } from "./ingest";
import { countEmails, statsEmails, verifCodes, markRead, toggleStar, getMetaOptions } from "./extra_endpoints";
import { createKey } from "./key_admin";
import { lookupKey, canAccess } from "./api_keys";
import { resolveScopedEmailFilter, checkRowAccess } from "./auth_scope";
import mail_accounts from "../user_api/mail_accounts";
import {
    DEFAULT_MAX_UNIFIED_PAGE_SIZE,
    HARD_MAX_UNIFIED_PAGE_SIZE,
    getMaxUnifiedPageSize,
} from "../quota.ts";

const api = new Hono<HonoCustomType>();

// 双通道鉴权：
//  1) x-user-token（用户登录，浏览器 UI 主路径）：解析 userPayload，按 ADMIN_USER_ROLE
//     判定管理员；普通用户的租户边界在 SQL 中按 account/address ownership 强制执行。
//  2) Authorization: Bearer <api-key>（程序化访问）：lookupKey + source/account 白名单。
// 两者都缺 → 401。用户 token 优先（同时存在时，浏览器语义以登录身份为准）。
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
            const isAdmin = !!c.env.ADMIN_USER_ROLE && userRole === c.env.ADMIN_USER_ROLE;
            c.set("unifiedUserAuth", { userPayload: payload, isAdmin, userRole });
            await next();
            return;
        } catch {
            return c.json({ error: "invalid user token" }, 401);
        }
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

const listEmails = async (c: Context<HonoCustomType>) => {
    const { limit, offset, ...rest } = c.req.query();
    const requestedLimit = typeof limit === "string" ? parseInt(limit, 10) : Number(limit);
    const maxPageSize = await getUnifiedPageQuota(c);
    if (Number.isFinite(requestedLimit) && requestedLimit > maxPageSize) {
        return c.json({
            error: "quota_exceeded",
            quota: "maxUnifiedPageSize",
            limit: maxPageSize,
        }, 400);
    }

    const { where, params } = await resolveScopedEmailFilter(c, rest);
    return handleListQuery(c,
        `SELECT id,source,account_id,from_addr,to_addr,subject,COALESCE(internal_date, received_at) as received_at,internal_date,is_read,is_starred,attachments_json FROM emails WHERE ${where}`,
        `SELECT count(*) as count FROM emails WHERE ${where}`,
        params, limit, offset, "COALESCE(internal_date, received_at) desc");
};

const getEmail = async (c: Context<HonoCustomType>) => {
    const row = await c.env.DB.prepare(`SELECT * FROM emails WHERE id = ?`)
        .bind(c.req.param("id")).first() as { source?: string | null; account_id?: string | null; to_addr?: string | null } | null;
    if (!row) return c.json({ error: "not found" }, 404);
    if (!(await checkRowAccess(c, row))) {
        return c.json({ error: "forbidden" }, 403);
    }
    return c.json(row);
};

api.get("/api/unified/emails", listEmails);
api.get("/api/unified/meta", getMetaOptions);
api.get("/api/unified/emails/:id", getEmail);
api.get("/api/unified/count", countEmails);
api.get("/api/unified/stats", statsEmails);
api.get("/api/unified/verifcodes", verifCodes);
api.post("/api/unified/emails/:id/read", markRead);   // readonly 被 canAccess 挡（POST）
api.post("/api/unified/emails/:id/star", toggleStar); // readonly 被 canAccess 挡（POST）
api.post("/admin/unified/ingest", ingestHandler);
api.get("/admin/unified/mail_accounts", mail_accounts.exportForAggregator);  // x-admin-auth 保护
api.post("/admin/unified/mail_accounts/:id/status", mail_accounts.reportStatus);  // 聚合器 sync 回写
api.post("/admin/unified/mail_accounts/:id/refresh_token", mail_accounts.reportRefreshToken);  // 聚合器 RT 轮换回写
// User-facing dispatch contracts live under /user_api; these admin routes are intentionally not exposed here.
api.post("/admin/unified/keys", createKey);           // x-admin-auth 保护

export default api;
