-- Index-servable keyset ordering for the unified list (D1 rows_read guard).
--
-- The unified list orders by COALESCE(internal_date, received_at) DESC, id DESC
-- under an account_id equality prefix. Without an index led by account_id and
-- carrying that exact expression, every list page and the auto-refresh probe's
-- LIMIT 1 degrades to a full account scan plus a temp b-tree sort (~22.5k
-- rows_read per query on a 22k-row mailbox; at the 10s auto-refresh floor that
-- alone can consume multiple D1 free-tier daily quotas per day).
-- idx_emails_order_received lacks the account_id prefix and the id tie-breaker,
-- so it cannot serve these account-scoped keyset pages; the binary
-- single-column indexes stay for the exact-match paths that still use them.
CREATE INDEX IF NOT EXISTS idx_emails_account_sortkey
  ON emails(account_id, COALESCE(internal_date, received_at) DESC, id DESC);
