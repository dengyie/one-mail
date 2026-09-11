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

-- source_key is the protocol/provider-specific stable identity. Current IMAP and
-- POP3 writers derive it from account + folder + UIDVALIDITY/UID or UIDL;
-- Graph uses the provider message identity. NULL means identity is unavailable,
-- never an empty/fabricated key.
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

CREATE TABLE IF NOT EXISTS mail_account_folders (
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
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (mail_account_id, canonical_name)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_account_folders_provider_id_uq
    ON mail_account_folders(mail_account_id, provider_folder_id)
    WHERE provider_folder_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mail_account_folders_account_type
    ON mail_account_folders(mail_account_id, folder_type, canonical_name);
