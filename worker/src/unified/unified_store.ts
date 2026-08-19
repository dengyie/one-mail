export interface UnifiedEmailRow {
    id: string; source: string; account_id: string | null;
    from_addr: string; to_addr: string; subject: string;
    text_body: string; html_body: string;
    received_at: number; internal_date: number | null;
    headers_json: string; is_read: number; flags_json: string;
    attachments_json: string; raw_ref: string | null; imap_uid: string | null;
    updated_at: number;
}

const stripAddr = (s: string): string => {
    const m = s.match(/<([^>]+)>/);
    return (m ? m[1] : s).trim();
};

export function buildUnifiedEmailRow(
    parsed: { sender?: string; subject?: string; text?: string; html?: string;
              attachments?: { filename?: string; mimeType?: string; content?: Uint8Array }[] } | undefined,
    toAddress: string, fromAddress: string, nowMs: number, id: string,
): UnifiedEmailRow {
    const atts = (parsed?.attachments ?? []).map((a) => ({
        name: a.filename ?? "", size: a.content?.length ?? 0, mimeType: a.mimeType ?? "",
    }));
    return {
        id,
        source: "cf_routing",
        account_id: toAddress,
        from_addr: stripAddr(parsed?.sender || fromAddress),
        to_addr: toAddress,
        subject: parsed?.subject ?? "",
        text_body: parsed?.text ?? "",
        html_body: parsed?.html ?? "",
        received_at: nowMs,
        internal_date: null,
        headers_json: "{}",
        is_read: 0,
        flags_json: "[]",
        attachments_json: JSON.stringify(atts),
        raw_ref: null,
        imap_uid: null,
        updated_at: nowMs,
    };
}

export async function saveUnifiedEmail(
    env: Bindings, rawEmail: string, fromAddress: string, toAddress: string,
): Promise<void> {
    // Lazy import: keeps the module graph light for pure-function unit tests and
    // is bundled into the same chunk by esbuild/wrangler in production.
    const { commonParseMail } = await import("../common.ts");
    const parsed = await commonParseMail({ rawEmail });
    const row = buildUnifiedEmailRow(parsed, toAddress, fromAddress, Date.now(), crypto.randomUUID());
    await env.DB.prepare(
        `INSERT OR IGNORE INTO emails
         (id,source,account_id,from_addr,to_addr,subject,text_body,html_body,
          received_at,internal_date,headers_json,is_read,flags_json,attachments_json,
          raw_ref,imap_uid,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
        row.id, row.source, row.account_id, row.from_addr, row.to_addr, row.subject,
        row.text_body, row.html_body, row.received_at, row.internal_date, row.headers_json,
        row.is_read, row.flags_json, row.attachments_json, row.raw_ref, row.imap_uid, row.updated_at,
    ).run();
}