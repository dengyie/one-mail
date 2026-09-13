-- Upgrade the original read/star-only durable mutation queue without losing
-- in-flight jobs. Deployment renders this file only when target_folder is
-- missing, so this destructive table rebuild is never replayed on an upgraded DB.
DROP TABLE IF EXISTS mail_mutation_jobs_v2;

CREATE TABLE mail_mutation_jobs_v2 (
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

INSERT INTO mail_mutation_jobs_v2 (
    id, email_id, account_id, source, to_addr, provider, operation, desired_value,
    source_folder, source_folder_id, target_folder, target_folder_id,
    provider_message_id, source_key, message_id_header,
    status, attempts, next_attempt_at, lease_token, lease_until, last_error,
    created_at, updated_at, completed_at
)
SELECT
    id, email_id, account_id, NULL, NULL, provider, operation, desired_value,
    source_folder, source_folder_id, NULL, NULL,
    provider_message_id, source_key, NULL,
    status, attempts, next_attempt_at, lease_token, lease_until, last_error,
    created_at, updated_at, completed_at
FROM mail_mutation_jobs;

DROP TABLE mail_mutation_jobs;
ALTER TABLE mail_mutation_jobs_v2 RENAME TO mail_mutation_jobs;

CREATE INDEX IF NOT EXISTS idx_mail_mutation_jobs_ready
    ON mail_mutation_jobs(status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_mail_mutation_jobs_email_operation
    ON mail_mutation_jobs(email_id, operation, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mail_mutation_jobs_account
    ON mail_mutation_jobs(account_id, status, created_at);