import { Context } from "hono";
import { INSERT_EMAIL_SQL } from "../core/ingest.ts";
import { loadShardMap } from "./shard_map.ts";
import { fetchShardJson } from "./shard_client.ts";
import { isShardMode } from "../core/d1_quota.ts";
import { IngestValidationError, insertArchive } from "./archival_ingest.ts";
import { lifecycleState } from "./account_lifecycle_schema.ts";

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
    if (![e.from_addr, e.to_addr, e.account_id].every(value => typeof value === "string" && value.length > 0)) {
        throw new Error("from_addr/to_addr/account_id required");
    }
    if (e.id != null && (typeof e.id !== "string" || !e.id.length || e.id.length > 200)) throw new Error("invalid email id");
    for (const name of ["received_at", "internal_date", "updated_at"]) {
        const value = e[name];
        if (value != null && (typeof value !== "number" || !Number.isSafeInteger(value))) throw new Error(`invalid ${name}`);
    }
    for (const name of ["is_read", "is_starred"]) {
        if (e[name] != null && e[name] !== 0 && e[name] !== 1) throw new Error(`invalid ${name}`);
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
        e.updated_at ?? nowMs,
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
        e.is_starred ?? 0,
    ];
}

type FolderType = "inbox" | "sent" | "drafts" | "archive" | "trash" | "spam" | "custom";
const VALID_FOLDER_TYPES = new Set<FolderType>([
    "inbox", "sent", "drafts", "archive", "trash", "spam", "custom",
]);

// Catalog discovery runs every five minutes. Preserve immediate metadata/error
// changes while coalescing the heartbeat repeated by each email in the folder.
const FOLDER_HEARTBEAT_MS = 300_000;

const folderType = (folder: string): FolderType => {
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
    displayName: string;
    providerFolderId: string | null;
    uidvalidity: number | null;
    folderType: FolderType;
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
            displayName: folder,
            providerFolderId,
            uidvalidity: nullableInteger(e.source_uidvalidity),
            folderType: folderType(folder),
        });
    }
    return [...byKey.values()];
};

const parseCatalogFolder = (value: unknown): FolderState | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const accountId = nullableText(row.account_id)?.trim() || null;
    const provider = nullableText(row.provider)?.trim().toLowerCase() || null;
    const folder = nullableText(row.canonical_name)?.trim() || null;
    if (!accountId || !folder || !provider || !["imap", "pop3", "graph"].includes(provider)) return null;

    const providerFolderId = nullableText(row.provider_folder_id)?.trim() || null;
    const displayName = nullableText(row.display_name)?.trim() || folder;
    const rawType = nullableText(row.folder_type)?.trim().toLowerCase() as FolderType | null;
    const resolvedType = rawType && VALID_FOLDER_TYPES.has(rawType) ? rawType : folderType(folder);
    const rawUidvalidity = row.uidvalidity;
    const uidvalidity = rawUidvalidity == null ? null : nullableInteger(rawUidvalidity);
    if (rawUidvalidity != null && (uidvalidity == null || uidvalidity <= 0)) return null;

    return {
        accountId,
        provider,
        folder,
        displayName,
        providerFolderId,
        uidvalidity,
        folderType: resolvedType,
    };
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
         WHERE account_id = ? AND provider = ? AND provider_message_id = ?
           AND (source_folder IS NOT COALESCE(?1, source_folder)
             OR source_folder_id IS NOT COALESCE(?2, source_folder_id)
             OR provider_thread_id IS NOT COALESCE(?3, provider_thread_id)
             OR message_id_header IS NOT COALESCE(?4, message_id_header)
             OR in_reply_to IS NOT COALESCE(?5, in_reply_to)
             OR references_json IS NOT COALESCE(?6, references_json)
             OR has_attachments IS NOT COALESCE(?7, has_attachments)
             OR sync_version IS NOT COALESCE(?8, sync_version))`
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
    // Filter unchanged rows before INSERT: a no-op UPSERT alone still advances
    // AUTOINCREMENT and writes sqlite_sequence. Identity indexes bound the probe.
    if (folder.providerFolderId) {
        // Stable provider identity is the conflict target. A rename updates the
        // same row instead of colliding on (or duplicating by) canonical_name.
        return c.env.DB.prepare(
            `INSERT INTO mail_account_folders (
                mail_account_id, provider, provider_folder_id, canonical_name, display_name,
                folder_type, uidvalidity, last_sync_at, created_at, updated_at
             ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE NOT EXISTS (
                SELECT 1 FROM mail_account_folders
                 WHERE mail_account_id = ?1 AND provider = ?2 AND provider_folder_id = ?3
                   AND canonical_name IS ?4 AND display_name IS ?5
                   AND (?6 = 'custom' OR folder_type IS ?6)
                   AND (?7 IS NULL OR uidvalidity IS ?7)
                   AND last_error IS NULL AND last_sync_at > ?8 - ${FOLDER_HEARTBEAT_MS}
             )
             ON CONFLICT(mail_account_id, provider, provider_folder_id)
             WHERE provider_folder_id IS NOT NULL
             DO UPDATE SET
                canonical_name = excluded.canonical_name,
                display_name = excluded.display_name,
                folder_type = CASE
                    WHEN excluded.folder_type = 'custom' THEN mail_account_folders.folder_type
                    ELSE excluded.folder_type
                END,
                uidvalidity = COALESCE(excluded.uidvalidity, mail_account_folders.uidvalidity),
                last_sync_at = excluded.last_sync_at,
                last_error = NULL,
                updated_at = excluded.updated_at`
        ).bind(
            folder.accountId,
            folder.provider,
            folder.providerFolderId,
            folder.folder,
            folder.displayName,
            folder.folderType,
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
         ) SELECT ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (
            SELECT 1 FROM mail_account_folders
             WHERE mail_account_id = ?1 AND provider = ?2 AND provider_folder_id IS NULL
               AND canonical_name = ?3 AND display_name IS ?4
               AND (?5 = 'custom' OR folder_type IS ?5)
               AND (?6 IS NULL OR uidvalidity IS ?6)
               AND last_error IS NULL AND last_sync_at > ?7 - ${FOLDER_HEARTBEAT_MS}
         )
         ON CONFLICT(mail_account_id, provider, canonical_name)
         WHERE provider_folder_id IS NULL
         DO UPDATE SET
            display_name = excluded.display_name,
            folder_type = CASE
                WHEN excluded.folder_type = 'custom' THEN mail_account_folders.folder_type
                ELSE excluded.folder_type
            END,
            uidvalidity = COALESCE(excluded.uidvalidity, mail_account_folders.uidvalidity),
            last_sync_at = excluded.last_sync_at,
            last_error = NULL,
            updated_at = excluded.updated_at`
    ).bind(
        folder.accountId,
        folder.provider,
        folder.folder,
        folder.displayName,
        folder.folderType,
        folder.uidvalidity,
        nowMs,
        nowMs,
        nowMs,
    );
};

export async function upsertFolders(c: Context<HonoCustomType>, folders: unknown[]): Promise<number> {
    if (!folders.length) return 0;
    const normalized = folders.map(parseCatalogFolder);
    if (normalized.some((folder) => folder == null)) {
        throw new Error("invalid folder catalog entry");
    }
    const nowMs = Date.now();
    const statements = (normalized as FolderState[]).map((folder) => buildFolderStatement(c, folder, nowMs));
    for (let start = 0; start < statements.length; start += 100) {
        await c.env.DB.batch(statements.slice(start, start + 100));
    }
    return statements.length;
}

export async function insertEmails(c: Context<HonoCustomType>, emails: Record<string, unknown>[]): Promise<{ inserted: number; skipped: number }> {
    let inserted = 0, skipped = 0;
    if (emails.length === 0) return { inserted, skipped };
    const activeEmails: Record<string, unknown>[] = [];
    // 一个批次通常整批来自同一个账号，逐封查 lifecycle 就是逐封查一次 D1
    // （聚合器 chunk_size=15，即每次 ingest 白跑 14 次查询）。按 account_id
    // 记忆化后典型情况只查一次；缓存 Promise 本身，同账号并发查询也只发一次。
    const lifecycleLookups = new Map<string, ReturnType<typeof lifecycleState>>();
    for (const email of emails) {
        const accountId = nullableText(email.account_id);
        if (!accountId) { activeEmails.push(email); continue; }
        let lookup = lifecycleLookups.get(accountId);
        if (!lookup) {
            lookup = lifecycleState(c.env.DB, accountId);
            lifecycleLookups.set(accountId, lookup);
        }
        if ((await lookup) == null) activeEmails.push(email);
        else skipped++;
    }
    emails = activeEmails;
    if (emails.length === 0) return { inserted, skipped };

    const nowMs = Date.now();
    const emailStatements = emails.map((e) => {
        const params = toEmailInsertParams(e, nullableText(e.id) ?? crypto.randomUUID(), nowMs);
        return c.env.DB.prepare(INSERT_EMAIL_SQL).bind(...(params as never[]));
    });
    const replayedEmails: Record<string, unknown>[] = [];

    // Keep batches bounded. Partial chunk success is safe because every email
    // insert is idempotent; an HTTP retry will report it as skipped and continue.
    for (let start = 0; start < emailStatements.length; start += 100) {
        const results = await c.env.DB.batch(emailStatements.slice(start, start + 100));
        for (const [index, r] of results.entries()) {
            const changes = (r.meta as { changes?: number })?.changes ?? 0;
            if (changes > 0) {
                inserted++;
                continue;
            }
            skipped++;
            replayedEmails.push(emails[start + index]);
        }
    }

    // A provider-stable replay (notably a Graph message moved to another folder)
    // is not a new email, but its mutable provider metadata must follow the source.
    const stateStatements = buildIdentityRefreshStatements(c, replayedEmails, nowMs);

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

type IngestBody = {
    emails?: Record<string, unknown>[];
    folders?: unknown[];
    migration?: boolean;
};

export const ingestHandler = async (c: Context<HonoCustomType>) => {
    let body: IngestBody;
    try {
        body = await c.req.json<IngestBody>();
    } catch {
        return c.json({ error: "invalid ingest JSON" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return c.json({ error: "ingest object required" }, 400);
    }
    const emails = body?.emails;
    const folders = body?.folders;

    if (emails != null && !Array.isArray(emails)) {
        return c.json({ error: "emails must be an array" }, 400);
    }
    if (folders != null && !Array.isArray(folders)) {
        return c.json({ error: "folders must be an array" }, 400);
    }

    const emailRows = emails || [];
    const folderRows = folders || [];
    if (emailRows.length === 0 && folderRows.length === 0) {
        return c.json({ error: "emails or folders array required" }, 400);
    }
    if (emailRows.length > 200 || folderRows.length > 200) {
        return c.json({ error: "max 200 emails or folders per request" }, 400);
    }

    if (body.migration != null && typeof body.migration !== "boolean") {
        return c.json({ error: "migration must be a boolean" }, 400);
    }
    if (body.migration) {
        if (!isShardMode(c.env)) return c.json({ error: "archive ingest requires shard mode" }, 400);
        try {
            return c.json(await insertArchive(c, emailRows, folderRows));
        } catch (error) {
            if (error instanceof IngestValidationError) return c.json({ error: error.message }, 400);
            throw error;
        }
    }
    // Reject malformed catalogs before email writes, not after partial success.
    if (folderRows.some(row => !parseCatalogFolder(row))) return c.json({ error: "invalid folder catalog entry" }, 400);
    for (const row of emailRows) {
        if (!row || typeof row !== "object" || Array.isArray(row)) return c.json({ error: "invalid email row" }, 400);
        try {
            toEmailInsertParams(row, "validation", 0);
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : "invalid email row" }, 400);
        }
    }
    if (isShardMode(c.env)) {
        if (emailRows.some(row => row.source === "cf_routing")) return c.json({ error: "native email belongs to primary" }, 400);
        const result = await insertEmails(c, emailRows);
        return c.json({ ...result, folders_upserted: await upsertFolders(c, folderRows) });
    }
    const map = await loadShardMap(c.env);
    const endpoints = new Map(map.shards.map(shard => [shard.id, shard]));
    const groups = new Map<string, { emails: Record<string, unknown>[]; folders: unknown[] }>();
    const group = (owner: string) => {
        let value = groups.get(owner);
        if (!value) { value = { emails: [], folders: [] }; groups.set(owner, value); }
        return value;
    };
    for (const row of emailRows) {
        const accountId = String(row.account_id);
        const owner = row.source !== "cf_routing" && Object.hasOwn(map.accounts, accountId) ? map.accounts[accountId] : "primary";
        group(owner).emails.push(row);
    }
    for (const row of folderRows) {
        const accountId = parseCatalogFolder(row)!.accountId;
        group(Object.hasOwn(map.accounts, accountId) ? map.accounts[accountId] : "primary").folders.push(row);
    }
    const results = await Promise.all([...groups].map(async ([owner, rows]) => {
        if (owner === "primary") {
            return { ...await insertEmails(c, rows.emails), folders_upserted: await upsertFolders(c, rows.folders) };
        }
        const shard = endpoints.get(owner);
        if (!shard) throw new Error("ingest destination missing");
        const result = await fetchShardJson<{ inserted: number; skipped: number; folders_upserted: number }>(shard, "/shard/ingest", { method: "POST", body: rows });
        if (!result.ok) {
            console.error("shard ingest failed", { shard_id: result.shard_id, error: result.error, cause: result.cause });
            return null;
        }
        const counts = result.data;
        if (![counts.inserted, counts.skipped, counts.folders_upserted].every(value => Number.isSafeInteger(value) && value >= 0)
            || counts.inserted + counts.skipped !== rows.emails.length
            || counts.folders_upserted > rows.folders.length) {
            console.error("invalid shard ingest acknowledgement", { shard_id: owner });
            return null;
        }
        return counts;
    }));
    // A retry replays successful destinations idempotently. Never acknowledge
    // failed uploads or fall back to primary after account ownership has changed.
    if (results.some(result => result === null)) return c.json({ error: "shard ingest unavailable; retry batch" }, 503);
    const total = { inserted: 0, skipped: 0, folders_upserted: 0 };
    for (const result of results) {
        if (!result) continue;
        total.inserted += result.inserted;
        total.skipped += result.skipped;
        total.folders_upserted += result.folders_upserted;
    }
    return c.json(total);
};
