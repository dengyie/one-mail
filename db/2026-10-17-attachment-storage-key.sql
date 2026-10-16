-- Rename the provisional legacy GC key column before VPS storage is enabled.
-- This migration is intentionally data-preserving and idempotent at the workflow layer.
ALTER TABLE attachment_gc RENAME COLUMN r2_key TO storage_key;
