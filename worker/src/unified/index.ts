import { Context, Hono } from "hono";
import { handleListQuery } from "../common";
import { buildEmailFilters } from "./unified_query";
import { ingestHandler } from "./ingest";

const api = new Hono<HonoCustomType>();

const listEmails = async (c: Context<HonoCustomType>) => {
    const { limit, offset, ...rest } = c.req.query();
    const { where, params } = buildEmailFilters(rest);
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