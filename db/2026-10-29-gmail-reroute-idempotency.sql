-- Idempotency for a Gmail reply rerouted off /api/send_mail.
-- This is not send_mail_limit_reservations: inserting there increments the
-- domain daily/monthly quota. Replay is safe; the statement creates nothing
-- when the table already exists.
CREATE TABLE IF NOT EXISTS gmail_reroute_idempotency (
    idempotency_key TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    job_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
