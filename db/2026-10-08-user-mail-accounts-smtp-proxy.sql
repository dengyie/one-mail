-- Render against PRAGMA table_info(user_mail_accounts) before execution.
-- Defaults match db/schema.sql and the admin initializer. Existing values stay intact.
ALTER TABLE user_mail_accounts ADD COLUMN smtp_host TEXT;
ALTER TABLE user_mail_accounts ADD COLUMN smtp_port INTEGER;
ALTER TABLE user_mail_accounts ADD COLUMN smtp_ssl INTEGER DEFAULT 1;
ALTER TABLE user_mail_accounts ADD COLUMN proxy_policy TEXT DEFAULT 'auto';
