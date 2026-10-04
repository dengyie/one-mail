ALTER TABLE sendbox ADD COLUMN source TEXT;
ALTER TABLE sendbox ADD COLUMN channel TEXT;
ALTER TABLE sendbox ADD COLUMN provider_message_id TEXT;
CREATE INDEX IF NOT EXISTS idx_sendbox_source ON sendbox(source);
CREATE INDEX IF NOT EXISTS idx_sendbox_address_source ON sendbox(address, source);
