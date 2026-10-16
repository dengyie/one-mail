import { Context } from "hono";
import { insertEmail } from "../core/ingest.ts";
import {
    MAX_ATTACHMENT_BYTES,
    attachmentGcInsert,
    attachmentKey,
    releaseAttachmentGc,
    safeAttachmentId,
    safeAttachmentName,
    safeMimeType,
} from "./attachments.ts";
import { uploadAttachmentObject } from "./storage_client.ts";

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

const nativeAttachmentId = async (
    index: number,
    name: string,
    mimeType: string,
    content: Uint8Array,
): Promise<string> => {
    const prefix = new TextEncoder().encode(`${index}\u0000${name}\u0000${mimeType}\u0000`);
    const bytes = new Uint8Array(prefix.byteLength + content.byteLength);
    bytes.set(prefix);
    bytes.set(content, prefix.byteLength);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return `native-${Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("").slice(0, 48)}`;
};

export async function saveUnifiedEmail(
    c: Context, rawEmail: string, fromAddress: string, toAddress: string,
    unifiedId?: string,
): Promise<void> {
    // Lazy import: keeps the module graph light for pure-function unit tests and
    // is bundled into the same chunk by esbuild/wrangler in production.
    const { commonParseMail } = await import("../common.ts");
    const parsed = await commonParseMail({ rawEmail });
    const row = buildUnifiedEmailRow(parsed, toAddress, fromAddress, Date.now(), unifiedId || crypto.randomUUID());
    const uploadedKeys: string[] = [];
    if (parsed?.attachments?.length) {
        if (!c.env.ATTACHMENT_STORAGE_URL || !c.env.ATTACHMENT_STORAGE_TOKEN) {
            throw new Error("attachment storage is not configured");
        }
        const storedAttachments = [];
        for (let index = 0; index < parsed.attachments.length; index += 1) {
            const attachment = parsed.attachments[index];
            const content = attachment.content instanceof Uint8Array
                ? attachment.content
                : new Uint8Array(attachment.content || []);
            const name = safeAttachmentName(attachment.filename || "attachment");
            const mimeType = safeMimeType(attachment.mimeType || "application/octet-stream");
            if (content.byteLength > MAX_ATTACHMENT_BYTES) {
                storedAttachments.push({ name, size: content.byteLength, mimeType });
                continue;
            }
            const id = await nativeAttachmentId(index, name, mimeType, content);
            if (!safeAttachmentId(id)) continue;
            const key = await attachmentKey(toAddress, row.id, id);
            if (!(await attachmentGcInsert(c.env, key))) {
                throw new Error("native attachment cleanup in progress; retry delivery");
            }
            await uploadAttachmentObject(c.env, key, content, content.byteLength, mimeType, name);
            uploadedKeys.push(key);
            storedAttachments.push({ id, name, size: content.byteLength, mimeType, storage_key: key });
        }
        row.attachments_json = JSON.stringify(storedAttachments);
        row.has_attachments = storedAttachments.length > 0 ? 1 : 0;
    }
    const result = await insertEmail(c, [
        row.id, row.source, row.account_id, row.from_addr, row.to_addr, row.subject,
        row.text_body, row.html_body, row.received_at, row.internal_date, row.headers_json,
        row.is_read, row.flags_json, row.attachments_json, row.raw_ref, row.imap_uid, row.updated_at,
        row.provider, row.source_folder, row.source_folder_id, row.provider_message_id,
        row.provider_thread_id, row.message_id_header, row.in_reply_to, row.references_json,
        row.has_attachments, row.source_key, row.sync_version, 0,
    ]);
    if ((result as { success?: boolean }).success) await releaseAttachmentGc(c.env, uploadedKeys, [row.id]);
}
