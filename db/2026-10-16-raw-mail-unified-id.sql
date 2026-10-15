ALTER TABLE raw_mails ADD COLUMN unified_id TEXT;
ALTER TABLE raw_mails ADD COLUMN mirror_pending INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_mails_unified_id_uq
    ON raw_mails(unified_id) WHERE unified_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_raw_mails_mirror_pending
    ON raw_mails(id) WHERE mirror_pending = 1;
