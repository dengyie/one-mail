-- Passkey challenge single-use store (D1 fallback when PASSKEY_CHALLENGES
-- Durable Object binding is absent). Idempotent; safe to replay.
CREATE TABLE IF NOT EXISTS passkey_challenges (
    challenge_key TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_passkey_challenges_expires_at
    ON passkey_challenges(expires_at);
