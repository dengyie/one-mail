import { Context } from "hono";
import { resolveScopedEmailFilter } from "./auth_scope";
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
    const { where, params } = await resolveScopedEmailFilter(c, c.req.query());
    const count = await c.env.DB.prepare(`SELECT count(*) as count FROM emails WHERE ${where}`)
        .bind(...params).first("count");
    return c.json({ count });
};

export const statsEmails = async (c: Context<HonoCustomType>) => {
    const { where, params } = await resolveScopedEmailFilter(c, c.req.query());
    const row = await c.env.DB.prepare(
        `SELECT count(*) as count,
                COALESCE(SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END), 0) as unread
         FROM emails WHERE ${where}`
    ).bind(...params).first() as { count?: number | string; unread?: number | string } | null;
    return c.json({
        count: Number(row?.count || 0),
        unread: Number(row?.unread || 0),
    });
};

function stripHtmlToText(html: string): string {
    if (!html) return "";
    return html
        .replace(/<\s*(script|style|head|svg)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\s+/g, " ")
        .trim();
}

export const verifCodes = async (c: Context<HonoCustomType>) => {
    const q = c.req.query();
    const addr = typeof q.addr === "string" ? q.addr.trim() : "";
    if (!addr) return c.json({ error: "addr required" }, 400);
    // 鉴权作用域直接进入 SQL；addr 仍作为业务过滤条件单独绑定。
    const { where, params } = await resolveScopedEmailFilter(c, { ...q, addr: undefined });
    let freshMs = 10 * 60 * 1000;                        // 默认 10 分钟内
    try { freshMs = intOr400(c, q.fresh, freshMs); } catch { return c.json({ error: "invalid fresh" }, 400); }
    // 兼容自适应：若用户通过 API 传入较小数值（如 fresh=10 或 fresh=60），自动识别为分钟并换算为毫秒
    if (freshMs > 0 && freshMs < 10000) {
        freshMs = freshMs * 60 * 1000;
    }
    const since = Date.now() - freshMs;
    // 优化投影：仅当 text_body 为空时截取前 8000 字符 HTML，避免 50 封邮件全量传输大体积 HTML 造成 D1 吞吐浪费与内存抖动
    const { results } = await c.env.DB.prepare(
        `SELECT subject, text_body,
                CASE WHEN (text_body IS NULL OR trim(text_body) = '')
                     THEN substr(html_body, 1, 8000)
                     ELSE '' END AS html_body,
                from_addr, received_at FROM emails
         WHERE ${where} AND to_addr = ? AND received_at >= ? ORDER BY received_at DESC LIMIT 50`
    ).bind(...params, addr, since).all();
    const out = (results as Record<string, unknown>[]).map((r) => {
        const text = (typeof r.text_body === "string" && r.text_body.trim())
            ? r.text_body
            : stripHtmlToText(typeof r.html_body === "string" ? r.html_body : "");
        return {
            from_addr: r.from_addr,
            subject: r.subject,
            received_at: r.received_at,
            code: extractVerifCode(`${r.subject ?? ""}\n${text}`),
        };
    }).filter((r) => r.code);
    return c.json({ results: out });
};

export const getMetaOptions = async (c: Context<HonoCustomType>) => {
    const { where, params } = await resolveScopedEmailFilter(c, {});
    const { results } = await c.env.DB.prepare(
        `SELECT DISTINCT source, account_id, to_addr FROM emails WHERE ${where} LIMIT 200`
    ).bind(...params).all<{ source: string | null; account_id: string | null; to_addr: string | null }>();
    const rows = results || [];
    const sources = [...new Set(rows.map((r) => r.source).filter(Boolean))];
    const accounts = [...new Set(rows.map((r) => r.account_id).filter(Boolean))];
    const to_addrs = [...new Set(rows.map((r) => r.to_addr).filter(Boolean))];
    return c.json({ sources, accounts, to_addrs });
};
