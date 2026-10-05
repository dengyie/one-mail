import type { Context } from "hono";

export const ARCHIVE_EMAIL_COLUMNS = [
    "id", "source", "account_id", "from_addr", "to_addr", "subject", "text_body", "html_body",
    "received_at", "internal_date", "headers_json", "is_read", "flags_json", "attachments_json",
    "raw_ref", "imap_uid", "updated_at", "provider", "source_folder", "source_folder_id",
    "provider_message_id", "provider_thread_id", "message_id_header", "in_reply_to",
    "references_json", "has_attachments", "source_key", "sync_version", "is_starred",
] as const;
export const ARCHIVE_FOLDER_COLUMNS = [
    "mail_account_id", "provider", "provider_folder_id", "canonical_name", "display_name",
    "folder_type", "uidvalidity", "last_cursor", "last_sync_at", "last_error", "created_at", "updated_at",
] as const;
const integers = new Set([
    "received_at", "internal_date", "is_read", "is_starred", "updated_at", "has_attachments",
    "sync_version", "uidvalidity", "last_sync_at", "created_at",
]);
const binary = new Set(["is_read", "is_starred", "has_attachments"]);
const required = new Set(["id", "source", "account_id", "from_addr", "to_addr", "received_at",
    "mail_account_id", "provider", "canonical_name", "folder_type", "created_at"]);
const folderTypes = new Set(["inbox", "sent", "drafts", "archive", "trash", "spam", "custom"]);
export class IngestValidationError extends Error {}

export function archivalValues(row: unknown, columns: readonly string[]): (string | number | null)[] {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new IngestValidationError("invalid archive row");
    const record = row as Record<string, unknown>;
    const folder = columns === ARCHIVE_FOLDER_COLUMNS;
    return columns.map(column => {
        if (!Object.hasOwn(record, column)) throw new IngestValidationError(`archive column required: ${column}`);
        const value = record[column];
        // Provider is nullable for legacy emails, but required for folder identity.
        if (value === null && !(folder && column === "updated_at")
            && (!required.has(column) || (column === "provider" && !folder))) return null;
        if (integers.has(column)) {
            if (typeof value !== "number" || !Number.isSafeInteger(value)
                || (binary.has(column) && value !== 0 && value !== 1)) {
                throw new IngestValidationError(`invalid archive integer: ${column}`);
            }
        } else if (typeof value !== "string" || (required.has(column) && !value.length)) {
            throw new IngestValidationError(`invalid archive text: ${column}`);
        }
        if (column === "source" && value === "cf_routing") throw new IngestValidationError("native email cannot be archived to a shard");
        if (column === "folder_type" && !folderTypes.has(value as string)) throw new IngestValidationError("invalid archive folder type");
        return value as string | number | null;
    });
}

export async function insertArchive(
    c: Context<HonoCustomType>, emails: Record<string, unknown>[], folders: unknown[],
): Promise<{ inserted: number; skipped: number; folders_upserted: number }> {
    // Validate the entire request before preparing any writes. Archive replay must
    // never refresh provider projections or overwrite live read/star/move state.
    const emailValues = emails.map(row => archivalValues(row, ARCHIVE_EMAIL_COLUMNS));
    const folderValues = folders.map(row => archivalValues(row, ARCHIVE_FOLDER_COLUMNS));
    const sql = (table: string, columns: readonly string[]) =>
        `INSERT OR IGNORE INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`;
    const emailStatements = emailValues.map(values => c.env.DB.prepare(sql("emails", ARCHIVE_EMAIL_COLUMNS)).bind(...values));
    const folderStatements = folderValues.map(values => c.env.DB.prepare(sql("mail_account_folders", ARCHIVE_FOLDER_COLUMNS)).bind(...values));
    let inserted = 0;
    let foldersUpserted = 0;
    for (let start = 0; start < emailStatements.length; start += 100) {
        const results = await c.env.DB.batch(emailStatements.slice(start, start + 100));
        inserted += results.reduce((count, result) => count + Number(result.meta.changes > 0), 0);
    }
    for (let start = 0; start < folderStatements.length; start += 100) {
        const results = await c.env.DB.batch(folderStatements.slice(start, start + 100));
        foldersUpserted += results.reduce((count, result) => count + Number(result.meta.changes > 0), 0);
    }
    return { inserted, skipped: emails.length - inserted, folders_upserted: foldersUpserted };
}
