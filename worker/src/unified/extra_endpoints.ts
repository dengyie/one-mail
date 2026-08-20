import { Context } from "hono";
import { buildEmailFilters } from "./unified_query";
import { scopeQuery } from "./api_keys";
import { extractVerifCode } from "./verifcode";

export const countEmails = async (c: Context<HonoCustomType>) => {
    const q = scopeQuery(c.get("apiKey"), c.req.query());
    const { where, params } = buildEmailFilters(q);
    const count = await c.env.DB.prepare(`SELECT count(*) as count FROM emails WHERE ${where}`)
        .bind(...params).first("count");
    return c.json({ count });
};

export const verifCodes = async (c: Context<HonoCustomType>) => {
    const q = c.req.query();
    const addr = q.addr;
    if (!addr) return c.json({ error: "addr required" }, 400);
    const freshMs = Number(q.fresh ?? 10 * 60 * 1000);   // 默认 10 分钟内
    const since = Date.now() - freshMs;
    const { results } = await c.env.DB.prepare(
        `SELECT subject, text_body, from_addr, received_at FROM emails
         WHERE to_addr = ? AND received_at >= ? ORDER BY received_at DESC LIMIT 5`
    ).bind(addr, since).all();
    const out = (results as Record<string, unknown>[]).map((r) => ({
        from_addr: r.from_addr, subject: r.subject, received_at: r.received_at,
        code: extractVerifCode(`${r.subject ?? ""}\n${r.text_body ?? ""}`),
    })).filter((r) => r.code);
    return c.json({ results: out });
};

export const markRead = async (c: Context<HonoCustomType>) => {
    const id = c.req.param("id");
    const { meta } = await c.env.DB.prepare(
        `UPDATE emails SET is_read = 1, updated_at = ? WHERE id = ?`
    ).bind(Date.now(), id).run();
    const changes = (meta as { changes?: number })?.changes ?? 0;
    return changes > 0 ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
};