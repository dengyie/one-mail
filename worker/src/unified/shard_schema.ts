import { ensureProviderIdentitySchema } from "./schema.ts";
import { ACCOUNT_LIFECYCLE_INIT_SQL } from "./account_lifecycle_schema.ts";

/**
 * Thin-shard D1: emails + folders + mutation jobs + locks. No users/settings.
 * ingest has no settings dependency; retention uses scheduled_locks only.
 */
export const SHARD_INIT_SQL = `
CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    account_id TEXT,
    from_addr TEXT NOT NULL,
    to_addr TEXT NOT NULL,
    subject TEXT,
    text_body TEXT,
    html_body TEXT,
    received_at INTEGER NOT NULL,
    internal_date INTEGER,
    headers_json TEXT,
    is_read INTEGER DEFAULT 0,
    is_starred INTEGER DEFAULT 0,
    flags_json TEXT,
    attachments_json TEXT,
    raw_ref TEXT,
    imap_uid TEXT,
    updated_at INTEGER,
    provider TEXT,
    source_folder TEXT,
    source_folder_id TEXT,
    provider_message_id TEXT,
    provider_thread_id TEXT,
    message_id_header TEXT,
    in_reply_to TEXT,
    references_json TEXT,
    has_attachments INTEGER,
    source_key TEXT,
    sync_version INTEGER
);
CREATE INDEX IF NOT EXISTS idx_emails_source ON emails(source);
CREATE INDEX IF NOT EXISTS idx_emails_account ON emails(account_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_to_addr ON emails(to_addr, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_received ON emails(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_order_received ON emails(COALESCE(internal_date, received_at) DESC);
CREATE INDEX IF NOT EXISTS idx_emails_read_received ON emails(is_read, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_star_received ON emails(is_starred, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_to_order_received ON emails(to_addr, COALESCE(internal_date, received_at) DESC);
CREATE INDEX IF NOT EXISTS idx_emails_to_read_received ON emails(to_addr, is_read, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_to_star_received ON emails(to_addr, is_starred, received_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_imap_uid ON emails(imap_uid) WHERE imap_uid IS NOT NULL;
CREATE TABLE IF NOT EXISTS attachment_gc (
    r2_key TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachment_gc_updated ON attachment_gc(updated_at, r2_key);
CREATE TABLE IF NOT EXISTS scheduled_locks (
    name TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    locked_until INTEGER NOT NULL
);
${ACCOUNT_LIFECYCLE_INIT_SQL}
`;

const toExecScript = (sql: string): string =>
    sql.replace(/[\r\n]/g, " ").split(";").map((part) => part.trim()).filter(Boolean).join(";\n");

export const initializeShardSchema = async (db: D1Database): Promise<void> => {
    try {
        await db.exec(toExecScript(SHARD_INIT_SQL));
        await ensureProviderIdentitySchema(db);
    } catch (cause) {
        throw new Error("Shard schema initialization failed", { cause });
    }
};
