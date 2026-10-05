-- Thin-shard D1 (docs/unified-inbox-sharding.md §5).
-- Runtime apply path: worker/src/unified/shard_schema.ts initializeShardSchema().
-- That helper execs this emails + attachment_gc + scheduled_locks subset, then
-- ensureProviderIdentitySchema() which adds provider-identity columns,
-- mail_account_folders, mail_mutation_jobs, and the current indexes.
-- SHARD_MODE initialize/migrate in admin_api/db_api.ts uses that helper
-- and never creates users/settings/sendbox/raw_mails.

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
