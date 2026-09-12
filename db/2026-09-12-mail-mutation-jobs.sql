CREATE TABLE IF NOT EXISTS mail_mutation_jobs (
    id TEXT PRIMARY KEY,
    email_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('set_read', 'set_starred')),
    desired_value INTEGER NOT NULL CHECK (desired_value IN (0, 1)),
    source_folder TEXT,
    source_folder_id TEXT,
    provider_message_id TEXT,
    source_key TEXT,
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
