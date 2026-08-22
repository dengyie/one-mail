-- one-mail Part 2: 普通用户自助接入外部邮箱归集
-- 每条记录是某个用户接入的一个外部邮箱（IMAP/POP3 app-password 或 OAuth）。
-- 聚合器经 /admin/unified/mail_accounts 拉取 enabled=1 的记录并解密凭据后归集，
-- 归集的邮件 to_addr = username，由 resolveScope 按 to_addr 隔离给该用户。
-- cred_enc = AES-GCM 加密（见 user_api/cred_crypto.ts），明文绝不落盘。

CREATE TABLE IF NOT EXISTS user_mail_accounts (
    id            TEXT PRIMARY KEY,
    user_id       INTEGER NOT NULL,
    label         TEXT,
    source        TEXT NOT NULL,        -- imap_gmail|imap_outlook|imap_qq|imap_163|imap_custom
    host          TEXT NOT NULL,
    port          INTEGER NOT NULL,
    username      TEXT NOT NULL,        -- 外部邮箱地址，归集后即 to_addr
    cred_enc      TEXT NOT NULL,        -- AES-GCM 加密的 app-password / OAuth json（base64 iv+ciphertext）
    protocol      TEXT DEFAULT 'auto',  -- imap|pop3|auto
    folders_json  TEXT,                 -- ["INBOX"]
    oauth_enc     TEXT,                 -- AES-GCM 加密的 OAuth 配置（可空）
    enabled       INTEGER DEFAULT 1,
    last_sync_at  INTEGER,
    last_error    TEXT,
    created_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_user_mail_accounts_user ON user_mail_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_user_mail_accounts_username ON user_mail_accounts(username);
CREATE INDEX IF NOT EXISTS idx_user_mail_accounts_enabled ON user_mail_accounts(enabled);
