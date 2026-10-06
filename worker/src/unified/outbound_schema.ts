/**
 * outbound_schema.ts — Shape-driven, idempotent schema repair for
 * external-account outbound sending (docs/send-mail-external-accounts.md).
 *
 * - Ensures the `can_send` column on `user_mail_accounts` (default 0).
 * - Creates `outbound_mail_jobs` with its indexes for the claim/execute/report
 *   pipeline shared by the Worker and the aggregator.
 *
 * Called from both db_api.initialize and db_api.migrate so fresh and existing
 * databases converge to the same shape regardless of deployment order.
 */

const OUTBOUND_MAIL_JOBS_DDL = `CREATE TABLE IF NOT EXISTS outbound_mail_jobs (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    from_addr TEXT NOT NULL,
    to_addr TEXT NOT NULL,
    subject TEXT NOT NULL,
    body_text TEXT,
    body_html TEXT,
    payload_json TEXT,
    request_hash TEXT NOT NULL,
    provider TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_until INTEGER,
    provider_message_id TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
)`;

const OUTBOUND_MAIL_JOBS_INDEXES = [
    `CREATE INDEX IF NOT EXISTS idx_outbound_pending
        ON outbound_mail_jobs (status, next_attempt_at)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_request_hash
        ON outbound_mail_jobs (account_id, request_hash)`,
];

/**
 * Shape-driven schema repair: adds `can_send` to `user_mail_accounts` and
 * creates `outbound_mail_jobs` + indexes if they do not yet exist.
 * Returns the list of column/table names that were added so the caller can
 * decide whether to bump db_version.
 */
export async function ensureOutboundSendSchema(db: D1Database): Promise<string[]> {
    const changes: string[] = [];

    // Add can_send column to user_mail_accounts (design doc §4.2).
    {
        const tableInfo = await db.prepare(`PRAGMA table_info(user_mail_accounts)`).all<{ name: string }>();
        const columns = new Set((tableInfo.results || []).map((row: { name: string }) => row.name));
        if (!columns.has("can_send")) {
            try {
                await db.prepare(`ALTER TABLE user_mail_accounts ADD COLUMN can_send INTEGER NOT NULL DEFAULT 0`).run();
                changes.push("user_mail_accounts.can_send");
            } catch (error) {
                // Two admin requests may race; duplicate-column means the peer
                // already completed this repair.
                if (!String(error).toLowerCase().includes("duplicate column")) {
                    throw error;
                }
            }
        }
    }

    // Create outbound_mail_jobs table (design doc §4.1).
    {
        const tableCheck = await db.prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'outbound_mail_jobs'`,
        ).first<{ name: string }>();
        if (!tableCheck) {
            await db.prepare(OUTBOUND_MAIL_JOBS_DDL).run();
            changes.push("outbound_mail_jobs");
        }
    }

    for (const indexSQL of OUTBOUND_MAIL_JOBS_INDEXES) {
        await db.prepare(indexSQL).run();
    }

    return changes;
}