-- backup_runs: ledger for the D1 -> R2 snapshot path (P0-2).
-- Fail-open: a missing table never blocks an export, but the cron path treats
-- an unavailable ledger as "skip" so it cannot retry every ten minutes.
CREATE TABLE IF NOT EXISTS backup_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
    object_key TEXT,
    bytes INTEGER,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    error TEXT
);

CREATE INDEX IF NOT EXISTS idx_backup_runs_started_at ON backup_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_backup_runs_status ON backup_runs (status, started_at DESC);
