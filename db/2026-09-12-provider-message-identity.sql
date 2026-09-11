-- Mail Service provider/folder/message identity foundation.
-- Existing emails.account_id is the canonical user_mail_accounts.id (TEXT), so no
-- duplicate mail_account_id column is introduced.

ALTER TABLE emails ADD COLUMN provider TEXT;
ALTER TABLE emails ADD COLUMN source_folder TEXT;
ALTER TABLE emails ADD COLUMN source_folder_id TEXT;
ALTER TABLE emails ADD COLUMN provider_message_id TEXT;
ALTER TABLE emails ADD COLUMN provider_thread_id TEXT;
ALTER TABLE emails ADD COLUMN message_id_header TEXT;
ALTER TABLE emails ADD COLUMN in_reply_to TEXT;
ALTER TABLE emails ADD COLUMN references_json TEXT;
ALTER TABLE emails ADD COLUMN has_attachments INTEGER;
ALTER TABLE emails ADD COLUMN source_key TEXT;
ALTER TABLE emails ADD COLUMN sync_version INTEGER;

-- Legacy imap_uid is already protected by a partial UNIQUE index, so copying it
-- into source_key is deterministic and cannot create a new collision. Do not
-- derive provider_message_id from RFC Message-ID, subject or timestamps: those
-- are not provider identities and false merges would be data loss.
UPDATE emails
   SET source_key = imap_uid
 WHERE source_key IS NULL AND imap_uid IS NOT NULL;

-- Protocol can be proven from the existing key namespace. Rows with an IMAP
-- shaped key predate provider identity and remain IMAP. Native CF-routing rows
-- are also unambiguous. Existing Graph rows keep their legacy source_key only;
-- ImmutableId is populated by the new writer for newly observed messages.
UPDATE emails
   SET provider = CASE
       WHEN source = 'cf_routing' THEN 'native'
       WHEN imap_uid LIKE 'graph:%' THEN 'graph'
       WHEN imap_uid LIKE 'pop3:%' THEN 'pop3'
       WHEN imap_uid IS NOT NULL THEN 'imap'
       ELSE provider
   END
 WHERE provider IS NULL;

UPDATE emails
   SET source_folder = 'INBOX', sync_version = 1
 WHERE source = 'cf_routing' AND source_folder IS NULL;

-- source_key is the protocol/provider-specific stable identity. Current IMAP and
-- POP3 writers derive it from account + folder + UIDVALIDITY/UID or UIDL. New
-- Graph writes use account + ImmutableId; migrated Graph rows retain the legacy
-- key until naturally re-observed because fabricating an ImmutableId is unsafe.
CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_source_key_uq
    ON emails(source_key) WHERE source_key IS NOT NULL;

-- provider_message_id is only populated when the provider offers an identity
-- that is stable for the account. IMAP UID is deliberately NOT written here.
CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_provider_message_uq
    ON emails(account_id, provider, provider_message_id)
    WHERE account_id IS NOT NULL
      AND provider IS NOT NULL
      AND provider_message_id IS NOT NULL;

-- Cursor-ready indexes. They keep the stable id tie-breaker in the index so
-- later keyset pagination never relies on OFFSET for large mailboxes.
CREATE INDEX IF NOT EXISTS idx_emails_order_cursor
    ON emails(COALESCE(internal_date, received_at) DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_emails_account_order_cursor
    ON emails(account_id, COALESCE(internal_date, received_at) DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_emails_to_order_cursor
    ON emails(to_addr, COALESCE(internal_date, received_at) DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_emails_account_folder_order_cursor
    ON emails(account_id, source_folder, COALESCE(internal_date, received_at) DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_emails_provider_thread
    ON emails(account_id, provider_thread_id)
    WHERE provider_thread_id IS NOT NULL;

-- Folder names are metadata, not universal identities. Graph/provider folders
-- can be renamed and hierarchical providers can expose duplicate display names.
-- Use a synthetic row id, then enforce provider_folder_id when the provider has
-- one. IMAP/POP3 (no provider folder id) fall back to canonical mailbox name.
CREATE TABLE IF NOT EXISTS mail_account_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mail_account_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_folder_id TEXT,
    canonical_name TEXT NOT NULL,
    display_name TEXT,
    folder_type TEXT NOT NULL CHECK (
        folder_type IN ('inbox', 'sent', 'drafts', 'archive', 'trash', 'spam', 'custom')
    ),
    uidvalidity INTEGER,
    last_cursor TEXT,
    last_sync_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_account_folders_provider_id_uq
    ON mail_account_folders(mail_account_id, provider, provider_folder_id)
    WHERE provider_folder_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_account_folders_canonical_uq
    ON mail_account_folders(mail_account_id, provider, canonical_name)
    WHERE provider_folder_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_mail_account_folders_account_type
    ON mail_account_folders(mail_account_id, folder_type, canonical_name);
