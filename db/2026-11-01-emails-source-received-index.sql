-- Optimize queries filtering by source with received_at ordering / window (e.g. verification code aggregation)
CREATE INDEX IF NOT EXISTS idx_emails_source_received
  ON emails(source, received_at DESC);
