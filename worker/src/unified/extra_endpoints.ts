import { Context } from "hono";
import { buildEmailFilters } from "./unified_query";
import { scopeQuery } from "./api_keys";
import { extractVerifCode } from "./verifcode";

/** 校验参数为十进制整数，失败抛 400 响应。 */
const intOr400 = (c: Context<HonoCustomType>, v: string | undefined, fallback: number): number => {
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
        c.status(400);
        throw new Error("invalid numeric param");
    }
    return n;
};

export const countEmails = async (c: Context<HonoCustomType>) => {
    const q = scopeQuery(c.get("apiKey"), c.req.query());
    const { where, params } = buildEmailFilters(q);
    const count = await c.env.DB.prepare(`SELECT count(*) as count FROM emails WHERE ${where}`)
        .bind(...params).first("count");
    return c.json({ count });
};

export const verifCodes = async (c: Context<HonoCustomType>) => {
    const key = c.get("apiKey");
    const q = c.req.query();
    const addr = q.addr;
    if (!addr) return c.json({ error: "addr required" }, 400);
    // 注入 key 白名单（若 key 限定 source/account，则 WHERE 必须带上）
    const scoped = scopeQuery(key, { ...q, addr: undefined });
    const { where, params } = buildEmailFilters(scoped);
    if (!where) return c.json({ error: "unscoped" }, 400);
    let freshMs = 10 * 60 * 1000;                        // 默认 10 分钟内
    try { freshMs = intOr400(c, q.fresh, freshMs); } catch { return c.json({ error: "invalid fresh" }, 400); }
    const since = Date.now() - freshMs;
    const { results } = await c.env.DB.prepare(
        `SELECT subject, text_body, from_addr, received_at FROM emails
         WHERE ${where} AND to_addr = ? AND received_at >= ? ORDER BY received_at DESC LIMIT 50`
    ).bind(...params, addr, since).all();
    const out = (results as Record<string, unknown>[]).map((r) => ({
        from_addr: r.from_addr, subject: r.subject, received_at: r.received_at,
        code: extractVerifCode(`${r.subject ?? ""}\n${r.text_body ?? ""}`),
    })).filter((r) => r.code);
    return c.json({ results: out });
};

export const markRead = async (c: Context<HonoCustomType>) => {
    const id = c.req.param("id");
    // 先确认行存在，避免"已读行 UPDATE 无生效行(rows-changed=0)"被误判为 404
    const exists = await c.env.DB.prepare(`SELECT id FROM emails WHERE id = ?`).bind(id).first();
    if (!exists) return c.json({ error: "not found" }, 404);
    await c.env.DB.prepare(`UPDATE emails SET is_read = 1, updated_at = ? WHERE id = ?`)
        .bind(Date.now(), id).run();
    return c.json({ ok: true });
};