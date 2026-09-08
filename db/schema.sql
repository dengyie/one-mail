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
    updated_at INTEGER
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
