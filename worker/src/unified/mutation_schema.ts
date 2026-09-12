const CREATE_MUTATION_TABLE = `CREATE TABLE IF NOT EXISTS mail_mutation_jobs (
    id TEXT PRIMARY KEY,
    email_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    source TEXT,
    to_addr TEXT,
    provider TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('set_read', 'set_starred', 'move', 'delete')),
    desired_value INTEGER CHECK (desired_value IS NULL OR desired_value IN (0, 1)),
    source_folder TEXT,
    source_folder_id TEXT,
    target_folder TEXT,
    target_folder_id TEXT,
    provider_message_id TEXT,
    source_key TEXT,
    message_id_header TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'processing', 'succeeded', 'failed', 'unsupported', 'superseded')
    ),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_until INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
)`;

const MUTATION_INDEX_STATEMENTS = [
    `CREATE INDEX IF NOT EXISTS idx_mail_mutation_jobs_ready
        ON mail_mutation_jobs(status, next_attempt_at, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_mail_mutation_jobs_email_operation
        ON mail_mutation_jobs(email_id, operation, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_mail_mutation_jobs_account
        ON mail_mutation_jobs(account_id, status, created_at)`,
];

const LEGACY_REBUILD_STATEMENTS = [
    `DROP TABLE IF EXISTS mail_mutation_jobs_v2`,
    CREATE_MUTATION_TABLE.replace("mail_mutation_jobs (", "mail_mutation_jobs_v2 (").replace("IF NOT EXISTS ", ""),
    `INSERT INTO mail_mutation_jobs_v2 (
        id, email_id, account_id, source, to_addr, provider, operation, desired_value,
        source_folder, source_folder_id, target_folder, target_folder_id,
        provider_message_id, source_key, message_id_header,
        status, attempts, next_attempt_at, lease_token, lease_until, last_error,
        created_at, updated_at, completed_at
     )
     SELECT
        id, email_id, account_id, NULL, NULL, provider, operation, desired_value,
        source_folder, source_folder_id, NULL, NULL,
        provider_message_id, source_key, NULL,
        status, attempts, next_attempt_at, lease_token, lease_until, last_error,
        created_at, updated_at, completed_at
     FROM mail_mutation_jobs`,
    `DROP TABLE mail_mutation_jobs`,
    `ALTER TABLE mail_mutation_jobs_v2 RENAME TO mail_mutation_jobs`,
];

/**
 * Shape-driven and idempotent so admin initialize/migrate can safely replay it.
 *
 * The first production version of this table had a SQLite CHECK that only
 * allowed read/star. SQLite cannot widen that CHECK with ADD COLUMN, so legacy
 * tables require one bounded rebuild. D1 batch keeps that rebuild together;
 * fresh/current tables only replay CREATE INDEX IF NOT EXISTS statements.
 */
export async function ensureMailMutationSchema(db: D1Database): Promise<void> {
    await db.prepare(CREATE_MUTATION_TABLE).run();

    const { results } = await db.prepare(`PRAGMA table_info(mail_mutation_jobs)`).all<{ name: string }>();
    const columns = new Set((results || []).map((row) => row.name));
    if (!columns.has("target_folder")) {
        await db.batch(LEGACY_REBUILD_STATEMENTS.map((sql) => db.prepare(sql)));
    }

    for (const sql of MUTATION_INDEX_STATEMENTS) {
        await db.prepare(sql).run();
    }
}