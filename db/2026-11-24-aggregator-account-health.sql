-- Aggregator account health snapshot + daemon heartbeat.
--
-- The aggregator (pxed one-mail-agg) reports per-account sync health for BOTH
-- static config.json accounts (qq-main, mail163-main — which have no
-- user_mail_accounts row, so the existing /status write-back 404s silently)
-- and user-managed accounts, plus a coarse daemon heartbeat. The admin status
-- page (/admin/health) reads this table instead of scraping logs.
--
-- Written by POST /admin/account_health (x-admin-auth, aggregator only).
-- Row churn is throttled aggregator-side (change-driven + 15min heartbeat),
-- so D1 write budget impact is a few rows per minute at worst.

CREATE TABLE IF NOT EXISTS aggregator_account_health (
    account_id TEXT PRIMARY KEY,
    label TEXT,
    source TEXT,
    username TEXT,
    user_managed INTEGER NOT NULL DEFAULT 0,
    last_sync_at INTEGER,
    last_error TEXT,
    error_kind TEXT,
    fail_count INTEGER NOT NULL DEFAULT 0,
    skip_until INTEGER,
    idle_alive INTEGER,
    poll_interval_seconds INTEGER,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS aggregator_daemon_heartbeat (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    started_at INTEGER,
    accounts_count INTEGER,
    socks5_egress TEXT,
    aggregator_version TEXT,
    updated_at INTEGER NOT NULL
);
