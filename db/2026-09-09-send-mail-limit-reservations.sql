-- Durable send-mail quota reservations.
-- Counter increments happen in the INSERT trigger and are released only by a
-- durable status transition, so a crashed request can be recovered by cron.
CREATE TABLE IF NOT EXISTS send_mail_limit_reservations (
    id TEXT PRIMARY KEY,
    daily_key TEXT,
    monthly_key TEXT,
    daily_limit INTEGER,
    monthly_limit INTEGER,
    status TEXT NOT NULL CHECK (status IN ('active', 'committed', 'released')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_send_mail_limit_reservations_expiry
    ON send_mail_limit_reservations(status, expires_at);

CREATE INDEX IF NOT EXISTS idx_send_mail_limit_reservations_terminal
    ON send_mail_limit_reservations(status, updated_at);

CREATE TRIGGER IF NOT EXISTS one_mail_send_limit_reservation_increment
AFTER INSERT ON send_mail_limit_reservations
WHEN NEW.status = 'active'
BEGIN
    INSERT OR IGNORE INTO settings(key, value)
        SELECT NEW.daily_key, '0' WHERE NEW.daily_key IS NOT NULL;
    UPDATE settings
       SET value = CAST(MAX(0, CAST(COALESCE(value, '0') AS INTEGER)) + 1 AS TEXT),
           updated_at = datetime('now')
     WHERE key = NEW.daily_key AND NEW.daily_key IS NOT NULL;

    INSERT OR IGNORE INTO settings(key, value)
        SELECT NEW.monthly_key, '0' WHERE NEW.monthly_key IS NOT NULL;
    UPDATE settings
       SET value = CAST(MAX(0, CAST(COALESCE(value, '0') AS INTEGER)) + 1 AS TEXT),
           updated_at = datetime('now')
     WHERE key = NEW.monthly_key AND NEW.monthly_key IS NOT NULL;
END;

CREATE TRIGGER IF NOT EXISTS one_mail_send_limit_reservation_release
AFTER UPDATE OF status ON send_mail_limit_reservations
WHEN OLD.status = 'active' AND NEW.status = 'released'
BEGIN
    UPDATE settings
       SET value = CAST(MAX(0, CAST(COALESCE(value, '0') AS INTEGER)) - 1 AS TEXT),
           updated_at = datetime('now')
     WHERE key = OLD.daily_key
       AND OLD.daily_key IS NOT NULL
       AND MAX(0, CAST(COALESCE(value, '0') AS INTEGER)) > 0;
    UPDATE settings
       SET value = CAST(MAX(0, CAST(COALESCE(value, '0') AS INTEGER)) - 1 AS TEXT),
           updated_at = datetime('now')
     WHERE key = OLD.monthly_key
       AND OLD.monthly_key IS NOT NULL
       AND MAX(0, CAST(COALESCE(value, '0') AS INTEGER)) > 0;
END;
