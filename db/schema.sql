CREATE TABLE IF NOT EXISTS raw_mails (
    id INTEGER PRIMARY KEY,
    message_id TEXT,
    source TEXT,
    address TEXT,
    raw TEXT,
    raw_blob BLOB,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_raw_mails_address ON raw_mails(address);

CREATE INDEX IF NOT EXISTS idx_raw_mails_created_at ON raw_mails(created_at);

CREATE INDEX IF NOT EXISTS idx_raw_mails_message_id ON raw_mails(message_id);

CREATE TABLE IF NOT EXISTS address (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    password TEXT,
    source_meta TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_address_name ON address(name);

CREATE INDEX IF NOT EXISTS idx_address_created_at ON address(created_at);

CREATE INDEX IF NOT EXISTS idx_address_updated_at ON address(updated_at);

CREATE INDEX IF NOT EXISTS idx_address_source_meta ON address(source_meta);

CREATE TABLE IF NOT EXISTS auto_reply_mails (
    id INTEGER PRIMARY KEY,
    source_prefix TEXT,
    name TEXT,
    address TEXT UNIQUE,
    subject TEXT,
    message TEXT,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auto_reply_mails_address ON auto_reply_mails(address);

CREATE TABLE IF NOT EXISTS address_sender (
    id INTEGER PRIMARY KEY,
    address TEXT UNIQUE,
    balance INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_address_sender_address ON address_sender(address);

CREATE TABLE IF NOT EXISTS sendbox (
    id INTEGER PRIMARY KEY,
    address TEXT,
    raw TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sendbox_address ON sendbox(address);

CREATE INDEX IF NOT EXISTS idx_sendbox_created_at ON sendbox(created_at);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    user_email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    user_info TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_user_email ON users(user_email);

CREATE TABLE IF NOT EXISTS users_address (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    address_id INTEGER UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_address_user_id ON users_address(user_id);

CREATE INDEX IF NOT EXISTS idx_users_address_address_id ON users_address(address_id);

CREATE TABLE IF NOT EXISTS user_roles (
    id INTEGER PRIMARY KEY,
    user_id INTEGER UNIQUE NOT NULL,
    role_text TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id);

CREATE TABLE IF NOT EXISTS user_passkeys (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    passkey_name TEXT NOT NULL,
    passkey_id TEXT NOT NULL,
    passkey TEXT NOT NULL,
    counter INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_passkeys_user_id ON user_passkeys(user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_passkeys_user_id_passkey_id ON user_passkeys(user_id, passkey_id);

CREATE TABLE IF NOT EXISTS user_mail_accounts (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    label TEXT,
    source TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    username TEXT NOT NULL,
    cred_enc TEXT NOT NULL,
    protocol TEXT DEFAULT 'auto',
    folders_json TEXT,
    oauth_enc TEXT,
    use_ssl INTEGER DEFAULT 1,
    pop3_host TEXT,
    pop3_port INTEGER,
    pop3_ssl INTEGER,
    pop3_use_stls INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1,
    last_sync_at INTEGER,
    last_error TEXT,
    created_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_user_mail_accounts_user ON user_mail_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_user_mail_accounts_username ON user_mail_accounts(username);
CREATE INDEX IF NOT EXISTS idx_user_mail_accounts_enabled ON user_mail_accounts(enabled);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_mail_accounts_username_uq
    ON user_mail_accounts(username) WHERE enabled = 1;

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
CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_source_key_uq ON emails(source_key) WHERE source_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_provider_message_uq
    ON emails(account_id, provider, provider_message_id)
    WHERE account_id IS NOT NULL AND provider IS NOT NULL AND provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_emails_order_cursor
    ON emails(COALESCE(internal_date, received_at) DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_emails_account_order_cursor
    ON emails(account_id, COALESCE(internal_date, received_at) DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_emails_to_order_cursor
    ON emails(to_addr, COALESCE(internal_date, received_at) DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_emails_account_folder_order_cursor
    ON emails(account_id, source_folder, COALESCE(internal_date, received_at) DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_emails_provider_thread
    ON emails(account_id, provider_thread_id) WHERE provider_thread_id IS NOT NULL;

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

CREATE TABLE IF NOT EXISTS mail_mutation_jobs (
    id TEXT PRIMARY KEY,
    email_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    source TEXT,
    to_addr TEXT,
    provider TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('set_read', 'set_starred', 'move', 'delete')),
    desired_value INTEGER CHECK (desired_value IS NULL OR desired_value IN (0, 1)),
    source_folder TEXT,
    source_folder_id TEXT,
    target_folder TEXT,
    target_folder_id TEXT,
    provider_message_id TEXT,
    source_key TEXT,
    message_id_header TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'processing', 'succeeded', 'failed', 'unsupported', 'superseded')
    ),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_until INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mail_mutation_jobs_ready
    ON mail_mutation_jobs(status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_mail_mutation_jobs_email_operation
    ON mail_mutation_jobs(email_id, operation, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mail_mutation_jobs_account
    ON mail_mutation_jobs(account_id, status, created_at);

CREATE TABLE IF NOT EXISTS scheduled_locks (
    name TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    locked_until INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_accounts (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    name TEXT,
    config_json TEXT,
    enabled INTEGER DEFAULT 1,
    last_sync_at INTEGER,
    created_at INTEGER
);

CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'readonly',
    allowed_sources TEXT,
    allowed_accounts TEXT,
    enabled INTEGER DEFAULT 1,
    created_at INTEGER,
    last_used_at INTEGER
);


-- Durable send-mail quota reservations.
-- Counter increments happen in the INSERT trigger and are released only by a
-- durable status transition, so a crashed request can be recovered by cron.
CREATE TABLE IF NOT EXISTS send_mail_limit_reservations (
    id TEXT PRIMARY KEY,
    daily_key TEXT,
    monthly_key TEXT,
    daily_limit INTEGER,
    monthly_limit INTEGER,
    status TEXT NOT NULL CHECK (status IN ('active', 'committed', 'released')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    dispatch_state TEXT NOT NULL DEFAULT 'pending' CHECK (dispatch_state IN ('pending', 'unknown', 'sent')),
    idempotency_key TEXT,
    request_hash TEXT,
    sender_address TEXT,
    sender_address_id TEXT,
    balance_reserved INTEGER NOT NULL DEFAULT 0,
    balance_refunded INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_send_mail_limit_reservations_expiry
    ON send_mail_limit_reservations(status, dispatch_state, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_send_mail_limit_reservations_idempotency
    ON send_mail_limit_reservations(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_send_mail_limit_reservations_terminal
    ON send_mail_limit_reservations(status, updated_at);

CREATE TRIGGER IF NOT EXISTS one_mail_send_limit_reservation_increment
AFTER INSERT ON send_mail_limit_reservations
WHEN NEW.status = 'active'
BEGIN
    INSERT OR IGNORE INTO settings(key, value)
        SELECT NEW.daily_key, '0' WHERE NEW.daily_key IS NOT NULL;
    UPDATE settings
       SET value = CAST(MAX(0, CAST(COALESCE(value, '0') AS INTEGER)) + 1 AS TEXT),
           updated_at = datetime('now')
     WHERE key = NEW.daily_key AND NEW.daily_key IS NOT NULL;

    INSERT OR IGNORE INTO settings(key, value)
        SELECT NEW.monthly_key, '0' WHERE NEW.monthly_key IS NOT NULL;
    UPDATE settings
       SET value = CAST(MAX(0, CAST(COALESCE(value, '0') AS INTEGER)) + 1 AS TEXT),
           updated_at = datetime('now')
     WHERE key = NEW.monthly_key AND NEW.monthly_key IS NOT NULL;
END;

CREATE TRIGGER IF NOT EXISTS one_mail_send_limit_reservation_release
AFTER UPDATE OF status ON send_mail_limit_reservations
WHEN OLD.status = 'active' AND NEW.status = 'released' AND OLD.dispatch_state = 'pending'
BEGIN
    UPDATE settings
       SET value = CAST(MAX(0, CAST(COALESCE(value, '0') AS INTEGER)) - 1 AS TEXT),
           updated_at = datetime('now')
     WHERE key = OLD.daily_key
       AND OLD.daily_key IS NOT NULL
       AND MAX(0, CAST(COALESCE(value, '0') AS INTEGER)) > 0;
    UPDATE settings
       SET value = CAST(MAX(0, CAST(COALESCE(value, '0') AS INTEGER)) - 1 AS TEXT),
           updated_at = datetime('now')
     WHERE key = OLD.monthly_key
       AND OLD.monthly_key IS NOT NULL
       AND MAX(0, CAST(COALESCE(value, '0') AS INTEGER)) > 0;
END;