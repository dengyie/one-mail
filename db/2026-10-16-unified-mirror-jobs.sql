CREATE TABLE IF NOT EXISTS unified_mirror_jobs (
    unified_id TEXT PRIMARY KEY,
    raw_mail_id INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_unified_mirror_jobs_due
    ON unified_mirror_jobs(next_attempt_at, created_at);
