import { Context } from "hono";
import { INSERT_EMAIL_SQL } from "../core/ingest.ts";

const jsonText = (value: unknown, fallback: unknown): string =>
    typeof value === "string" ? value : JSON.stringify(value ?? fallback);

const nullableText = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;

const hasAttachments = (e: Record<string, unknown>): number | null => {
    if (e.has_attachments === 0 || e.has_attachments === 1) return e.has_attachments;
    const value = e.attachments_json;
    if (Array.isArray(value)) return value.length > 0 ? 1 : 0;
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? (parsed.length > 0 ? 1 : 0) : null;
        } catch {
            return null;
        }
    }
    return null;
};

export function toEmailInsertParams(e: Record<string, unknown>, id: string, nowMs: number): unknown[] {
    // from_addr/to_addr/account_id 必须非空：account_id 是外部邮件稳定租户身份；
    // CF native 双写路径 account_id=toAddress 恒非空。
    if (!e.from_addr || !e.to_addr || !e.account_id) {
        throw new Error("from_addr/to_addr/account_id required");
    }
    const legacyImapUid = nullableText(e.imap_uid);
    // 兼容滚动部署：旧 aggregator 尚未发送 source_key 时，现有 imap_uid 本身已经
    // 是 account/folder/UIDVALIDITY/UID（或 POP3/Graph legacy key）的稳定去重键。
    const sourceKey = nullableText(e.source_key) ?? legacyImapUid;
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
        jsonText(e.headers_json, {}),
        e.is_read ?? 0,
        jsonText(e.flags_json, []),
        jsonText(e.attachments_json, []),
        e.raw_ref ?? null,
        legacyImapUid,
        nowMs,
        nullableText(e.provider),
        nullableText(e.source_folder),
        nullableText(e.source_folder_id),
        nullableText(e.provider_message_id),
        nullableText(e.provider_thread_id),
        nullableText(e.message_id_header),
        nullableText(e.in_reply_to),
        e.references_json == null ? null : jsonText(e.references_json, []),
        hasAttachments(e),
        sourceKey,
        Number.isInteger(e.sync_version) ? e.sync_version : null,
    ];
}

const folderType = (folder: string): "inbox" | "sent" | "drafts" | "archive" | "trash" | "spam" | "custom" => {
    const normalized = folder.trim().toLowerCase();
    if (normalized === "inbox") return "inbox";
    if (["sent", "sent items", "sent messages"].includes(normalized)) return "sent";
    if (["draft", "drafts"].includes(normalized)) return "drafts";
    if (["archive", "all mail", "all"].includes(normalized)) return "archive";
    if (["trash", "deleted", "deleted items"].includes(normalized)) return "trash";
    if (["spam", "junk", "junk email"].includes(normalized)) return "spam";
    return "custom";
};

interface FolderState {
    accountId: string;
    provider: string;
    folder: string;
    uidvalidity: number | null;
}

const collectFolders = (emails: Record<string, unknown>[]): FolderState[] => {
    const byKey = new Map<string, FolderState>();
    for (const e of emails) {
        const accountId = nullableText(e.account_id);
        const provider = nullableText(e.provider);
        const folder = nullableText(e.source_folder);
        if (!accountId || !provider || !folder) continue;
        const rawUidValidity = e.source_uidvalidity;
        const uidvalidity = typeof rawUidValidity === "number" && Number.isInteger(rawUidValidity)
            ? rawUidValidity : null;
        byKey.set(`${accountId}\u0000${folder}`, { accountId, provider, folder, uidvalidity });
    }
    return [...byKey.values()];
};

export async function insertEmails(c: Context<HonoCustomType>, emails: Record<string, unknown>[]): Promise<{ inserted: number; skipped: number }> {
    let inserted = 0, skipped = 0;
    if (emails.length === 0) return { inserted, skipped };

    const nowMs = Date.now();
    const emailStatements = emails.map((e) => {
        const params = toEmailInsertParams(e, crypto.randomUUID(), nowMs);
        return c.env.DB.prepare(INSERT_EMAIL_SQL).bind(...(params as never[]));
    });

    // 同一上传批次顺手登记实际观察到的文件夹，不增加网络 round-trip。
    // provider_folder_id 暂不从“显示名称”猜测；只有未来 provider adapter 拿到
    // 真正稳定 folder ID 时才写该列。
    const folderStatements = collectFolders(emails).map((folder) => c.env.DB.prepare(
        `INSERT INTO mail_account_folders (
            mail_account_id, provider, provider_folder_id, canonical_name, display_name,
            folder_type, uidvalidity, last_sync_at, created_at, updated_at
         ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(mail_account_id, canonical_name) DO UPDATE SET
            provider = excluded.provider,
            display_name = excluded.display_name,
            folder_type = excluded.folder_type,
            uidvalidity = COALESCE(excluded.uidvalidity, mail_account_folders.uidvalidity),
            last_sync_at = excluded.last_sync_at,
            last_error = NULL,
            updated_at = excluded.updated_at`
    ).bind(
        folder.accountId,
        folder.provider,
        folder.folder,
        folder.folder,
        folderType(folder.folder),
        folder.uidvalidity,
        nowMs,
        nowMs,
        nowMs,
    ));

    // Cloudflare D1 batch executes all statements in a single round-trip transaction.
    // Email statements stay first so inserted/skipped counts are not polluted by folder upserts.
    const results = await c.env.DB.batch([...emailStatements, ...folderStatements]);
    for (const r of results.slice(0, emailStatements.length)) {
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
