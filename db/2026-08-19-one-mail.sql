CREATE TABLE IF NOT EXISTS emails (
    id             TEXT PRIMARY KEY,
    source         TEXT NOT NULL,
    account_id     TEXT,
    from_addr      TEXT NOT NULL,
    to_addr        TEXT NOT NULL,
    subject        TEXT,
    text_body      TEXT,
    html_body      TEXT,
    received_at    INTEGER NOT NULL,
    internal_date  INTEGER,
    headers_json   TEXT,
    is_read        INTEGER DEFAULT 0,
    flags_json     TEXT,
    attachments_json TEXT,
    raw_ref        TEXT,
    imap_uid       TEXT,
    updated_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_emails_source    ON emails(source);
CREATE INDEX IF NOT EXISTS idx_emails_account   ON emails(account_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_to_addr   ON emails(to_addr, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_received  ON emails(received_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_imap_uid
    ON emails(imap_uid) WHERE imap_uid IS NOT NULL;

CREATE TABLE IF NOT EXISTS mail_accounts (
    id           TEXT PRIMARY KEY,
    source_type  TEXT NOT NULL,
    name         TEXT,
    config_json  TEXT,
    enabled      INTEGER DEFAULT 1,
    last_sync_at INTEGER,
    created_at   INTEGER
);

CREATE TABLE IF NOT EXISTS api_keys (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    key_hash        TEXT NOT NULL UNIQUE,
    role            TEXT NOT NULL DEFAULT 'readonly',
    allowed_sources TEXT,
    allowed_accounts TEXT,
    enabled         INTEGER DEFAULT 1,
    created_at      INTEGER,
    last_used_at    INTEGER
);