import { Context } from "hono";
import { mapVerifCodeRows, extractVerifCode, stripHtmlToText, type VerifRow } from "../unified/verifcode.ts";
import { resolveRawEmailList } from "../gzip.ts";
import { commonParseMail } from "../common.ts";
import { listRawMails } from "../core/mail-list.ts";

/** 校验参数为十进制正整数，失败抛 fallback。 */
const parsePositiveInt = (v: string | undefined, fallback: number): number => {
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.floor(n);
};

/**
 * 获取指定邮箱地址的验证码列表（优先 emails 表投影，必要时 raw_mails 兜底）。
 */
export const fetchAddressVerifCodes = async (
    c: Context<HonoCustomType>,
    address: string,
    freshParam?: string,
    limitParam?: string,
): Promise<VerifRow[]> => {
    const rawFresh = parsePositiveInt(freshParam, 10 * 60 * 1000);
    // 兼容分钟数（如 fresh=10 或 fresh=60 自动换算为毫秒）
    const freshMs = rawFresh < 10000 ? rawFresh * 60 * 1000 : rawFresh;
    const lim = Math.min(parsePositiveInt(limitParam, 10), 50);
    const since = Date.now() - freshMs;

    // 1. 优先走优化投影的 emails 表（利用索引 idx_emails_to_addr，截断前 3000 字符）
    // 扫描深度：lim * 5，下限 50，上限 100，确保在普通邮件干扰下仍能扫出验证码
    const fetchLimit = Math.min(Math.max(lim * 5, 50), 100);
    const { results } = await c.env.DB.prepare(
        `SELECT subject,
                CASE WHEN (text_body IS NOT NULL AND trim(text_body) != '')
                     THEN substr(text_body, 1, 3000)
                     ELSE '' END AS text_body,
                CASE WHEN (text_body IS NULL OR trim(text_body) = '')
                     THEN substr(html_body, 1, 3000)
                     ELSE '' END AS html_body,
                from_addr, to_addr, received_at, source FROM emails
         WHERE to_addr = ? AND received_at >= ?
         ORDER BY received_at DESC LIMIT ?`
    ).bind(address.toLowerCase(), since, fetchLimit).all();

    const out = mapVerifCodeRows((results || []) as Record<string, unknown>[], stripHtmlToText);

    // 2. 检查 raw_mails 是否有更新但尚未镜像到 emails 的邮件，或补全未填满的验证码
    try {
        const rawRows = await listRawMails(c, address, { limit: Math.min(Math.max(lim * 2, 10), 20), offset: 0 });
        if (rawRows && rawRows.length > 0) {
            const resolved = await resolveRawEmailList(rawRows);
            for (const row of resolved) {
                const rawStr = typeof row.raw === "string" ? row.raw : "";
                const createdTime = row.created_at ? new Date(row.created_at).getTime() : Date.now();
                if (Number.isFinite(createdTime) && createdTime < since) continue;

                let code: string | null = null;
                let subject = "";
                let sender = "";

                // 若 metadata 明确为 auth_code 类型且通过验证码提取校验才复用
                if (row.metadata) {
                    try {
                        const meta = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
                        if (meta?.ai_extract?.type === "auth_code" && meta.ai_extract.result) {
                            const candidate = extractVerifCode(String(meta.ai_extract.result).trim());
                            if (candidate) code = candidate;
                        }
                    } catch { /* ignore invalid json */ }
                }

                if (!code && rawStr) {
                    const parsed = await commonParseMail({ rawEmail: rawStr });
                    subject = parsed?.subject ?? "";
                    sender = parsed?.sender ?? "";
                    const textContent = `${subject}\n${parsed?.text ?? ""}\n${stripHtmlToText(parsed?.html ?? "")}`;
                    code = extractVerifCode(textContent);
                }

                if (code) {
                    const rowSender = sender || (row.source && row.source !== "raw_mails" ? row.source : "") || "";
                    // 查重：若 emails 投影中已有同验证码、同邮箱且时间相差 <10 秒的记录，则跳过
                    const isDup = out.some(
                        (existing) =>
                            existing.code === code &&
                            Math.abs(Number(existing.received_at) - createdTime) < 10000 &&
                            (!rowSender || !existing.from_addr || existing.from_addr === rowSender)
                    );
                    if (!isDup) {
                        out.push({
                            code,
                            from_addr: rowSender,
                            to_addr: address,
                            subject: subject,
                            received_at: createdTime,
                            source: row.source || "raw_mails",
                        });
                    }
                }
            }
        }
    } catch {
        // raw_mails 降级处理
    }

    // 按接收时间降序排序（确保最新收到的验证码排在首位）
    out.sort((a, b) => Number(b.received_at) - Number(a.received_at));

    return out.slice(0, lim);
};

export const listVerifCodes = async (c: Context<HonoCustomType>) => {
    const { address } = c.get("jwtPayload") || {};
    if (!address) {
        return c.json({ error: "No address" }, 400);
    }
    const q = c.req.query();
    const results = await fetchAddressVerifCodes(c, address, q.fresh, q.limit);
    return c.json({ results });
};

export const getLatestVerifCode = async (c: Context<HonoCustomType>) => {
    const { address } = c.get("jwtPayload") || {};
    if (!address) {
        return c.json({ error: "No address" }, 400);
    }
    const q = c.req.query();
    const results = await fetchAddressVerifCodes(c, address, q.fresh, "1");
    if (results.length > 0) {
        return c.json(results[0]);
    }
    return c.json({ code: null });
};

export default {
    listVerifCodes,
    getLatestVerifCode,
    fetchAddressVerifCodes,
};
