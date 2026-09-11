import { Context } from "hono";
import { INSERT_EMAIL_SQL } from "../core/ingest.ts";

const jsonText = (value: unknown, fallback: unknown): string =>
    typeof value === "string" ? value : JSON.stringify(value ?? fallback);

const nullableText = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;

const nullableInteger = (value: unknown): number | null =>
    typeof value === "number" && Number.isInteger(value) ? value : null;

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
    const provider = nullableText(e.provider);
    const providerMessageId = nullableText(e.provider_message_id);
    if (providerMessageId && !provider) {
        throw new Error("provider required when provider_message_id is set");
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
        jsonText(e.headers_json, {}),
        e.is_read ?? 0,
        jsonText(e.flags_json, []),
        jsonText(e.attachments_json, []),
        e.raw_ref ?? null,
        legacyImapUid,
        nowMs,
        provider,
        nullableText(e.source_folder),
        nullableText(e.source_folder_id),
        providerMessageId,
        nullableText(e.provider_thread_id),
        nullableText(e.message_id_header),
        nullableText(e.in_reply_to),
        e.references_json == null ? null : jsonText(e.references_json, []),
        hasAttachments(e),
        sourceKey,
        nullableInteger(e.sync_version),
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
    providerFolderId: string | null;
    uidvalidity: number | null;
}

const collectFolders = (emails: Record<string, unknown>[]): FolderState[] => {
    const byKey = new Map<string, FolderState>();
    for (const e of emails) {
        const accountId = nullableText(e.account_id);
        const provider = nullableText(e.provider);
        const folder = nullableText(e.source_folder);
        if (!accountId || !provider || !folder) continue;
        const providerFolderId = nullableText(e.source_folder_id);
        // A stable provider folder ID wins over names: Graph folders can be
        // renamed and hierarchical providers can have duplicate display names.
        const identity = providerFolderId ? `id:${providerFolderId}` : `name:${folder}`;
        byKey.set(`${accountId}\u0000${provider}\u0000${identity}`, {
            accountId,
            provider,
            folder,
            providerFolderId,
            uidvalidity: nullableInteger(e.source_uidvalidity),
        });
    }
    return [...byKey.values()];
};

const buildIdentityRefreshStatements = (
    c: Context<HonoCustomType>,
    emails: Record<string, unknown>[],
    nowMs: number,
) => emails.flatMap((e) => {
    const accountId = nullableText(e.account_id);
    const provider = nullableText(e.provider);
    const providerMessageId = nullableText(e.provider_message_id);
    if (!accountId || !provider || !providerMessageId) return [];
    return [c.env.DB.prepare(
        `UPDATE emails SET
            source_folder = COALESCE(?, source_folder),
            source_folder_id = COALESCE(?, source_folder_id),
            provider_thread_id = COALESCE(?, provider_thread_id),
            message_id_header = COALESCE(?, message_id_header),
            in_reply_to = COALESCE(?, in_reply_to),
            references_json = COALESCE(?, references_json),
            has_attachments = COALESCE(?, has_attachments),
            sync_version = COALESCE(?, sync_version),
            updated_at = ?
         WHERE account_id = ? AND provider = ? AND provider_message_id = ?`
    ).bind(
        nullableText(e.source_folder),
        nullableText(e.source_folder_id),
        nullableText(e.provider_thread_id),
        nullableText(e.message_id_header),
        nullableText(e.in_reply_to),
        e.references_json == null ? null : jsonText(e.references_json, []),
        hasAttachments(e),
        nullableInteger(e.sync_version),
        nowMs,
        accountId,
        provider,
        providerMessageId,
    )];
});

const buildFolderStatement = (
    c: Context<HonoCustomType>,
    folder: FolderState,
    nowMs: number,
) => {
    const type = folderType(folder.folder);
    if (folder.providerFolderId) {
        // Stable provider identity is the conflict target. A rename updates the
        // same row instead of colliding on (or duplicating by) canonical_name.
        return c.env.DB.prepare(
            `INSERT INTO mail_account_folders (
                mail_account_id, provider, provider_folder_id, canonical_name, display_name,
                folder_type, uidvalidity, last_sync_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(mail_account_id, provider, provider_folder_id)
             WHERE provider_folder_id IS NOT NULL
             DO UPDATE SET
                canonical_name = excluded.canonical_name,
                display_name = excluded.display_name,
                folder_type = excluded.folder_type,
                uidvalidity = excluded.uidvalidity,
                last_sync_at = excluded.last_sync_at,
                last_error = NULL,
                updated_at = excluded.updated_at`
        ).bind(
            folder.accountId,
            folder.provider,
            folder.providerFolderId,
            folder.folder,
            folder.folder,
            type,
            folder.uidvalidity,
            nowMs,
            nowMs,
            nowMs,
        );
    }

    // IMAP/POP3 have no stable provider folder id. Their canonical mailbox
    // name/path is the identity until an adapter can supply a stronger one.
    return c.env.DB.prepare(
        `INSERT INTO mail_account_folders (
            mail_account_id, provider, provider_folder_id, canonical_name, display_name,
            folder_type, uidvalidity, last_sync_at, created_at, updated_at
         ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(mail_account_id, provider, canonical_name)
         WHERE provider_folder_id IS NULL
         DO UPDATE SET
            display_name = excluded.display_name,
            folder_type = excluded.folder_type,
            uidvalidity = excluded.uidvalidity,
            last_sync_at = excluded.last_sync_at,
            last_error = NULL,
            updated_at = excluded.updated_at`
    ).bind(
        folder.accountId,
        folder.provider,
        folder.folder,
        folder.folder,
        type,
        folder.uidvalidity,
        nowMs,
        nowMs,
        nowMs,
    );
};

export async function insertEmails(c: Context<HonoCustomType>, emails: Record<string, unknown>[]): Promise<{ inserted: number; skipped: number }> {
    let inserted = 0, skipped = 0;
    if (emails.length === 0) return { inserted, skipped };

    const nowMs = Date.now();
    const emailStatements = emails.map((e) => {
        const params = toEmailInsertParams(e, crypto.randomUUID(), nowMs);
        return c.env.DB.prepare(INSERT_EMAIL_SQL).bind(...(params as never[]));
    });

    // Keep batches bounded. Partial chunk success is safe because every email
    // insert is idempotent; an HTTP retry will report it as skipped and continue.
    for (let start = 0; start < emailStatements.length; start += 100) {
        const results = await c.env.DB.batch(emailStatements.slice(start, start + 100));
        for (const r of results) {
            const changes = (r.meta as { changes?: number })?.changes ?? 0;
            if (changes > 0) inserted++; else skipped++;
        }
    }

    // A provider-stable replay (notably a Graph message moved to another folder)
    // is not a new email, but its mutable provider metadata must follow the source.
    const stateStatements = buildIdentityRefreshStatements(c, emails, nowMs);

    // Register folders observed in the same ingest operation. Provider folders
    // key by their stable ID; IMAP/POP3 fall back to canonical mailbox name.
    for (const folder of collectFolders(emails)) {
        stateStatements.push(buildFolderStatement(c, folder, nowMs));
    }

    for (let start = 0; start < stateStatements.length; start += 100) {
        await c.env.DB.batch(stateStatements.slice(start, start + 100));
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
