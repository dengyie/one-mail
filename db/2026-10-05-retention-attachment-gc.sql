-- Durable attachment garbage-collection queue. Email deletion and enqueue
-- happen in one D1 batch; VPS object deletion is performed only after that commit.
CREATE TABLE IF NOT EXISTS attachment_gc (
    storage_key TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachment_gc_updated ON attachment_gc(updated_at, storage_key);
