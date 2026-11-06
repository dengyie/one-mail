-- audit_logs: append-only trail for high-risk admin operations.
-- Fail-open by design: a missing table or write error must never block the
-- operation being audited. Idempotent; safe to replay.
CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    detail_json TEXT,
    ip TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs (actor, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs (action, created_at DESC);
