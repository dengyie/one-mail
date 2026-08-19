import { Context } from "hono";

export function toEmailInsertParams(e: Record<string, unknown>, id: string, nowMs: number): unknown[] {
    if (!e.from_addr || !e.to_addr) throw new Error("from_addr/to_addr required");
    return [
        id,
        e.source ?? "imap_unknown",
        e.account_id ?? null,
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

const INSERT_SQL = `INSERT OR IGNORE INTO emails
  (id,source,account_id,from_addr,to_addr,subject,text_body,html_body,
   received_at,internal_date,headers_json,is_read,flags_json,attachments_json,
   raw_ref,imap_uid,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

export async function insertEmails(env: Bindings, emails: Record<string, unknown>[]): Promise<{ inserted: number; skipped: number }> {
    let inserted = 0, skipped = 0;
    for (const e of emails) {
        const params = toEmailInsertParams(e, crypto.randomUUID(), Date.now());
        const { meta } = await env.DB.prepare(INSERT_SQL).bind(...(params as never[])).run();
        const changes = (meta as { changes?: number })?.changes ?? 0;
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
    const result = await insertEmails(c.env, emails);
    return c.json(result);
};