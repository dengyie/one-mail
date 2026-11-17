-- Case-insensitive recipient lookups (emails.to_addr / address.name).
--
-- to_addr is stored with the mailbox's original case (e.g.
-- KevinWalters5892@outlook.com) while every read path compares it
-- case-insensitively. Without a NOCASE index those comparisons degrade to a
-- full table scan on the emails table, and D1 bills rows_read per row.
--
-- The binary indexes are kept: source/account_id joins and the exact-match
-- paths that still use `=` keep using them, and SQLite picks the index that
-- matches the comparison's collation.
CREATE INDEX IF NOT EXISTS idx_emails_to_addr_nocase
  ON emails(to_addr COLLATE NOCASE, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_address_name_nocase
  ON address(name COLLATE NOCASE);
