-- Durable provider-dispatch state and idempotency for send-mail quota reservations.
-- Apply after 2026-09-09-send-mail-limit-reservations.sql.
ALTER TABLE send_mail_limit_reservations ADD COLUMN dispatch_state TEXT NOT NULL DEFAULT 'pending' CHECK (dispatch_state IN ('pending', 'unknown', 'sent'));
ALTER TABLE send_mail_limit_reservations ADD COLUMN idempotency_key TEXT;
ALTER TABLE send_mail_limit_reservations ADD COLUMN request_hash TEXT;
DROP TRIGGER IF EXISTS one_mail_send_limit_reservation_release;
CREATE UNIQUE INDEX IF NOT EXISTS idx_send_mail_limit_reservations_idempotency ON send_mail_limit_reservations(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_send_mail_limit_reservations_expiry ON send_mail_limit_reservations(status, dispatch_state, expires_at);
CREATE TRIGGER IF NOT EXISTS one_mail_send_limit_reservation_release AFTER UPDATE OF status ON send_mail_limit_reservations WHEN OLD.status = 'active' AND NEW.status = 'released' AND OLD.dispatch_state = 'pending' BEGIN
 UPDATE settings SET value = CAST(MAX(0, CAST(COALESCE(value, '0') AS INTEGER)) - 1 AS TEXT), updated_at = datetime('now') WHERE key = OLD.daily_key AND OLD.daily_key IS NOT NULL AND MAX(0, CAST(COALESCE(value, '0') AS INTEGER)) > 0;
 UPDATE settings SET value = CAST(MAX(0, CAST(COALESCE(value, '0') AS INTEGER)) - 1 AS TEXT), updated_at = datetime('now') WHERE key = OLD.monthly_key AND OLD.monthly_key IS NOT NULL AND MAX(0, CAST(COALESCE(value, '0') AS INTEGER)) > 0;
END;
