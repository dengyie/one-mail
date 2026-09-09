import { Context, Hono } from "hono";
import { handleListQuery, commonGetUserRole } from "../common";
import { buildEmailFilters } from "./unified_query";
import { ingestHandler } from "./ingest";
import { countEmails, statsEmails, verifCodes, markRead, toggleStar, getMetaOptions } from "./extra_endpoints";
import { createKey } from "./key_admin";
import { lookupKey, canAccess, userAddressScope } from "./api_keys";
import { resolveScope, checkRowAccess } from "./auth_scope";
import mail_accounts from "../user_api/mail_accounts";

const api = new Hono<HonoCustomType>();

// 双通道鉴权：
//  1) x-user-token（用户登录，浏览器 UI 主路径）：解析 userPayload，按 ADMIN_USER_ROLE
//     判定管理员；管理员看全部，普通用户注入 to_addr 归属作用域。
//  2) Authorization: Bearer <api-key>（程序化访问，原逻辑不变）：lookupKey + canAccess。
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
            // 管理员判定：role_text == ADMIN_USER_ROLE（环境变量）。未配置 ADMIN_USER_ROLE
            // 时任何用户都不算管理员，落到普通用户的 to_addr 作用域。
            const isAdmin = !!c.env.ADMIN_USER_ROLE
                && (await commonGetUserRole(c, payload.user_id))?.role === c.env.ADMIN_USER_ROLE;
            let toAddrScope: string | undefined;
            if (!isAdmin) {
                toAddrScope = await userAddressScope(c.env.DB, payload.user_id);
            }
            c.set("unifiedUserAuth", { userPayload: payload, isAdmin, toAddrScope });
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

const listEmails = async (c: Context<HonoCustomType>) => {
    const { limit, offset, ...rest } = c.req.query();
    const q = await resolveScope(c, rest);
    if (q === null) return c.json({ results: [], count: 0 });
    const { where, params } = buildEmailFilters(q);
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
// User-facing dispatch contracts live under /user_api; these admin routes are intentionally not exposed here.
api.post("/admin/unified/keys", createKey);           // x-admin-auth 保护

export default api;
