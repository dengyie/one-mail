import { Context } from "hono";
import { insertEmail } from "../core/ingest.ts";

export interface UnifiedEmailRow {
    id: string; source: string; account_id: string | null;
    from_addr: string; to_addr: string; subject: string;
    text_body: string; html_body: string;
    received_at: number; internal_date: number | null;
    headers_json: string; is_read: number; flags_json: string;
    attachments_json: string; raw_ref: string | null; imap_uid: string | null;
    updated_at: number;
    provider: string | null; source_folder: string | null; source_folder_id: string | null;
    provider_message_id: string | null; provider_thread_id: string | null;
    message_id_header: string | null; in_reply_to: string | null; references_json: string | null;
    has_attachments: number | null; source_key: string | null; sync_version: number | null;
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
        provider: "native",
        source_folder: "INBOX",
        source_folder_id: null,
        provider_message_id: null,
        provider_thread_id: null,
        message_id_header: null,
        in_reply_to: null,
        references_json: null,
        has_attachments: atts.length > 0 ? 1 : 0,
        // Native Email Routing delivery already has a primary UUID. Do not invent a
        // second identity key from mutable headers/address metadata.
        source_key: null,
        sync_version: 1,
    };
}

export async function saveUnifiedEmail(
    c: Context, rawEmail: string, fromAddress: string, toAddress: string,
): Promise<void> {
    // Lazy import: keeps the module graph light for pure-function unit tests and
    // is bundled into the same chunk by esbuild/wrangler in production.
    const { commonParseMail } = await import("../common.ts");
    const parsed = await commonParseMail({ rawEmail });
    const row = buildUnifiedEmailRow(parsed, toAddress, fromAddress, Date.now(), crypto.randomUUID());
    await insertEmail(c, [
        row.id, row.source, row.account_id, row.from_addr, row.to_addr, row.subject,
        row.text_body, row.html_body, row.received_at, row.internal_date, row.headers_json,
        row.is_read, row.flags_json, row.attachments_json, row.raw_ref, row.imap_uid, row.updated_at,
        row.provider, row.source_folder, row.source_folder_id, row.provider_message_id,
        row.provider_thread_id, row.message_id_header, row.in_reply_to, row.references_json,
        row.has_attachments, row.source_key, row.sync_version,
    ]);
}