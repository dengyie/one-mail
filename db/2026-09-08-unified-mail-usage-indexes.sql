-- Reduce full scans for unified inbox listing, status filters and retention cleanup.
CREATE INDEX IF NOT EXISTS idx_emails_order_received
  ON emails(COALESCE(internal_date, received_at) DESC);
CREATE INDEX IF NOT EXISTS idx_emails_read_received
  ON emails(is_read, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_star_received
  ON emails(is_starred, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_to_order_received
  ON emails(to_addr, COALESCE(internal_date, received_at) DESC);
CREATE INDEX IF NOT EXISTS idx_emails_to_read_received
  ON emails(to_addr, is_read, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_to_star_received
  ON emails(to_addr, is_starred, received_at DESC);
