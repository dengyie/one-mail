-- scheduled_locks: cron retention lock table used by worker/src/scheduled.ts.
-- It lives in shard_schema.ts (thin-shard init) and admin db_api init, but the
-- production primary D1 was provisioned before either path ran, so the 10-minute
-- cron logs D1_ERROR: no such table: scheduled_locks on every fire.
-- Idempotent; safe to replay.
CREATE TABLE IF NOT EXISTS scheduled_locks (
    name TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    locked_until INTEGER NOT NULL
);
