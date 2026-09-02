import { Context } from "hono";
import { buildEmailFilters } from "./unified_query";
import { resolveScope, checkRowAccess } from "./auth_scope";
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
    const q = await resolveScope(c, c.req.query());
    if (q === null) return c.json({ count: 0 });
    const { where, params } = buildEmailFilters(q);
    const count = await c.env.DB.prepare(`SELECT count(*) as count FROM emails WHERE ${where}`)
        .bind(...params).first("count");
    return c.json({ count });
};

export const verifCodes = async (c: Context<HonoCustomType>) => {
    const q = c.req.query();
    const addr = q.addr;
    if (!addr) return c.json({ error: "addr required" }, 400);
    // 注入鉴权作用域（用户 to_addr / API-key 白名单），并去掉透传的 addr（下方单独绑定）
    const scoped = await resolveScope(c, { ...q, addr: undefined });
    if (scoped === null) return c.json({ results: [] });
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
    // 先取行（含 to_addr/source/account_id 用于行级校验），不存在 → 404
    const row = await c.env.DB.prepare(
        `SELECT id, source, account_id, to_addr FROM emails WHERE id = ?`
    ).bind(id).first() as { source?: string | null; account_id?: string | null; to_addr?: string | null } | null;
    if (!row) return c.json({ error: "not found" }, 404);
    if (!(await checkRowAccess(c, row))) {
        return c.json({ error: "forbidden" }, 403);
    }
    await c.env.DB.prepare(`UPDATE emails SET is_read = 1, updated_at = ? WHERE id = ?`)
        .bind(Date.now(), id).run();
    return c.json({ ok: true });
};

export const toggleStar = async (c: Context<HonoCustomType>) => {
    const id = c.req.param("id");
    const row = await c.env.DB.prepare(
        `SELECT id, source, account_id, to_addr, is_starred FROM emails WHERE id = ?`
    ).bind(id).first() as { source?: string | null; account_id?: string | null; to_addr?: string | null; is_starred?: number | null } | null;
    if (!row) return c.json({ error: "not found" }, 404);
    if (!(await checkRowAccess(c, row))) {
        return c.json({ error: "forbidden" }, 403);
    }
    const body = await c.req.json<{ is_starred?: number }>().catch(() => ({}));
    let newStarred: number;
    if (body && typeof body.is_starred === "number") {
        newStarred = body.is_starred ? 1 : 0;
    } else {
        newStarred = (row.is_starred === 1) ? 0 : 1;
    }
    await c.env.DB.prepare(`UPDATE emails SET is_starred = ?, updated_at = ? WHERE id = ?`)
        .bind(newStarred, Date.now(), id).run();
    return c.json({ ok: true, is_starred: newStarred });
};

export const getMetaOptions = async (c: Context<HonoCustomType>) => {
    const q = await resolveScope(c, {});
    if (q === null) return c.json({ sources: [], accounts: [], to_addrs: [] });
    const { where, params } = buildEmailFilters(q);
    const { results } = await c.env.DB.prepare(
        `SELECT DISTINCT source, account_id, to_addr FROM emails WHERE ${where} LIMIT 200`
    ).bind(...params).all<{ source: string | null; account_id: string | null; to_addr: string | null }>();
    const rows = results || [];
    const sources = [...new Set(rows.map((r) => r.source).filter(Boolean))];
    const accounts = [...new Set(rows.map((r) => r.account_id).filter(Boolean))];
    const to_addrs = [...new Set(rows.map((r) => r.to_addr).filter(Boolean))];
    return c.json({ sources, accounts, to_addrs });
};


