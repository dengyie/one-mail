import { Context, Hono } from "hono";
import { handleListQuery } from "../common";
import { buildEmailFilters } from "./unified_query";
import { ingestHandler } from "./ingest";
import { lookupKey, canAccess, scopeQuery } from "./api_keys";

const api = new Hono<HonoCustomType>();

// Bearer API-key auth + readonly scoping on the unified inbox API.
// worker.ts 已把 /api/unified 从 JWT 层放行，由本中间件接管鉴权。
api.use("/api/unified/*", async (c, next) => {
    const auth = c.req.raw.headers.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return c.json({ error: "missing bearer token" }, 401);
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
    const { where, params } = buildEmailFilters(scopeQuery(c.get("apiKey"), rest));
    return handleListQuery(c,
        `SELECT id,source,account_id,from_addr,to_addr,subject,received_at,is_read,attachments_json FROM emails WHERE ${where}`,
        `SELECT count(*) as count FROM emails WHERE ${where}`,
        params, limit, offset, "received_at desc");
};

const getEmail = async (c: Context<HonoCustomType>) => {
    const row = await c.env.DB.prepare(`SELECT * FROM emails WHERE id = ?`)
        .bind(c.req.param("id")).first();
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(row);
};

api.get("/api/unified/emails", listEmails);
api.get("/api/unified/emails/:id", getEmail);
api.post("/admin/unified/ingest", ingestHandler);

export default api;