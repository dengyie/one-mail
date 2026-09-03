import { Context } from "hono";
import { insertEmail, INSERT_EMAIL_SQL } from "../core/ingest.ts";

export function toEmailInsertParams(e: Record<string, unknown>, id: string, nowMs: number): unknown[] {
    // from_addr/to_addr/account_id 必须非空：account_id=NULL 的行会被
    // fail-closed 白名单挡在所有的 readonly key 之外，等同于不可见/不可管理
    // （C1 相关）。CF 双写路径 account_id=toAddress 恒非空，不受影响。
    if (!e.from_addr || !e.to_addr || !e.account_id) {
        throw new Error("from_addr/to_addr/account_id required");
    }
    return [
        id,
        e.source ?? "imap_unknown",
        e.account_id,
        e.from_addr, e.to_addr,
        e.subject ?? "",
        e.text_body ?? "",
        e.html_body ?? "",
        e.received_at ?? nowMs,
        e.internal_date ?? null,
        typeof e.headers_json === "string" ? e.headers_json : JSON.stringify(e.headers_json ?? {}),
        e.is_read ?? 0,
        typeof e.flags_json === "string" ? e.flags_json : JSON.stringify(e.flags_json ?? []),
        typeof e.attachments_json === "string" ? e.attachments_json : JSON.stringify(e.attachments_json ?? []),
        e.raw_ref ?? null,
        e.imap_uid ?? null,
        nowMs,
    ];
}

export async function insertEmails(c: Context<HonoCustomType>, emails: Record<string, unknown>[]): Promise<{ inserted: number; skipped: number }> {
    let inserted = 0, skipped = 0;
    if (emails.length === 0) return { inserted, skipped };

    const batchStatements = emails.map((e) => {
        const params = toEmailInsertParams(e, crypto.randomUUID(), Date.now());
        return c.env.DB.prepare(INSERT_EMAIL_SQL).bind(...(params as never[]));
    });

    // Cloudflare D1 batch executes all statements in a single round-trip transaction
    const results = await c.env.DB.batch(batchStatements);
    for (const r of results) {
        const changes = (r.meta as { changes?: number })?.changes ?? 0;
        if (changes > 0) inserted++; else skipped++;
    }
    return { inserted, skipped };
}

export const ingestHandler = async (c: Context<HonoCustomType>) => {
    const body = await c.req.json<{ emails?: Record<string, unknown>[] }>().catch(() => ({}));
    const emails = body?.emails;
    if (!Array.isArray(emails) || emails.length === 0) {
        return c.json({ error: "emails array required" }, 400);
    }
    if (emails.length > 200) {
        return c.json({ error: "max 200 emails per request" }, 400);
    }
    const result = await insertEmails(c, emails);
    return c.json(result);
};