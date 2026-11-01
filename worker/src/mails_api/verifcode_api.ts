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
    const fetchLimit = Math.max(lim * 2, 20);
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

    // 2. 兜底逻辑：若 emails 表未命中（如历史未镜像邮件或镜像任务积压中），从 raw_mails 读取
    if (out.length === 0) {
        try {
            const rawRows = await listRawMails(c, address, { limit: Math.min(lim, 10), offset: 0 });
            if (rawRows && rawRows.length > 0) {
                const resolved = await resolveRawEmailList(rawRows);
                for (const row of resolved) {
                    const rawStr = typeof row.raw === "string" ? row.raw : "";
                    const createdTime = row.created_at ? new Date(row.created_at).getTime() : Date.now();
                    if (Number.isFinite(createdTime) && createdTime < since) continue;

                    let code: string | null = null;
                    let subject = "";
                    let sender = "";

                    // 若 metadata 已有 ai_extract 识别结果直接复用
                    if (row.metadata) {
                        try {
                            const meta = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
                            if (meta?.ai_extract?.result) {
                                code = String(meta.ai_extract.result);
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
                        out.push({
                            code,
                            from_addr: sender || row.source || "",
                            to_addr: address,
                            subject: subject,
                            received_at: createdTime,
                            source: row.source || "raw_mails",
                        });
                        if (out.length >= lim) break;
                    }
                }
            }
        } catch {
            // raw_mails 兜底错误静默降级
        }
    }

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
