const PROVIDER_IDENTITY_COLUMNS: Array<[string, string]> = [
    ["provider", "TEXT"],
    ["source_folder", "TEXT"],
    ["source_folder_id", "TEXT"],
    ["provider_message_id", "TEXT"],
    ["provider_thread_id", "TEXT"],
    ["message_id_header", "TEXT"],
    ["in_reply_to", "TEXT"],
    ["references_json", "TEXT"],
    ["has_attachments", "INTEGER"],
    ["source_key", "TEXT"],
    ["sync_version", "INTEGER"],
];

const runStatement = async (db: D1Database, sql: string): Promise<void> => {
    await db.prepare(sql).run();
};

async function ensureColumn(
    db: D1Database,
    table: string,
    name: string,
    definition: string,
): Promise<boolean> {
    const tableInfo = await db.prepare(`PRAGMA table_info(${table})`).all();
    if ((tableInfo.results ?? []).some((column: any) => column.name === name)) return false;
    try {
        await runStatement(db, `ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
        return true;
    } catch (error) {
        // Two admin migration requests can race after reading the same shape.
        // Duplicate-column means the peer completed this exact repair; all
        // other errors remain fail-closed.
        if (!String(error).toLowerCase().includes("duplicate column")) throw error;
        return false;
    }
}

/**
 * Bring both fresh and legacy D1 databases to the provider identity schema.
 *
 * This helper is intentionally shape-driven rather than version-driven. A stale
 * or prematurely bumped db_version must never make the Worker assume columns or
 * indexes exist when they do not.
 */
export async function ensureProviderIdentitySchema(db: D1Database): Promise<string[]> {
    const changes: string[] = [];

    for (const [name, definition] of PROVIDER_IDENTITY_COLUMNS) {
        if (await ensureColumn(db, "emails", name, definition)) {
            changes.push(`emails.${name}`);
        }
    }

    // D1 exec() is a script API and treats newlines as statement separators.
    // Every statement in this shape-repair helper is a single prepared query so
    // multiline CASE/DDL formatting cannot be split into incomplete SQL.
    await runStatement(
        db,
        `UPDATE emails
            SET source_key = imap_uid
          WHERE source_key IS NULL AND imap_uid IS NOT NULL`,
    );
    await runStatement(
        db,
        `UPDATE emails
            SET provider = CASE
                WHEN source = 'cf_routing' THEN 'native'
                WHEN imap_uid LIKE 'graph:%' THEN 'graph'
                WHEN imap_uid LIKE 'pop3:%' THEN 'pop3'
                WHEN imap_uid IS NOT NULL THEN 'imap'
                ELSE provider
            END
          WHERE provider IS NULL`,
    );
    await runStatement(
        db,
        `UPDATE emails
            SET source_folder = 'INBOX', sync_version = COALESCE(sync_version, 1)
          WHERE source = 'cf_routing' AND source_folder IS NULL`,
    );

    const folderTable = await db.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mail_account_folders'`,
    ).first();
    if (!folderTable) changes.push("mail_account_folders");

    // Folder names are metadata. Provider folders (Graph today, future Gmail
    // adapters) key by provider_folder_id so renames do not create a new row.
    // IMAP/POP3 have no provider folder id and key by canonical mailbox name.
    await runStatement(db, `CREATE TABLE IF NOT EXISTS mail_account_folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mail_account_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_folder_id TEXT,
        canonical_name TEXT NOT NULL,
        display_name TEXT,
        folder_type TEXT NOT NULL CHECK (
            folder_type IN ('inbox', 'sent', 'drafts', 'archive', 'trash', 'spam', 'custom')
        ),
        uidvalidity INTEGER,
        last_cursor TEXT,
        last_sync_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    )`);

    const indexStatements = [
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_source_key_uq
            ON emails(source_key) WHERE source_key IS NOT NULL`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_provider_message_uq
            ON emails(account_id, provider, provider_message_id)
            WHERE account_id IS NOT NULL
              AND provider IS NOT NULL
              AND provider_message_id IS NOT NULL`,
        `CREATE INDEX IF NOT EXISTS idx_emails_order_cursor
            ON emails(COALESCE(internal_date, received_at) DESC, id DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_emails_account_order_cursor
            ON emails(account_id, COALESCE(internal_date, received_at) DESC, id DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_emails_to_order_cursor
            ON emails(to_addr, COALESCE(internal_date, received_at) DESC, id DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_emails_account_folder_order_cursor
            ON emails(account_id, source_folder, COALESCE(internal_date, received_at) DESC, id DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_emails_provider_thread
            ON emails(account_id, provider_thread_id)
            WHERE provider_thread_id IS NOT NULL`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_account_folders_provider_id_uq
            ON mail_account_folders(mail_account_id, provider, provider_folder_id)
            WHERE provider_folder_id IS NOT NULL`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_account_folders_canonical_uq
            ON mail_account_folders(mail_account_id, provider, canonical_name)
            WHERE provider_folder_id IS NULL`,
        `CREATE INDEX IF NOT EXISTS idx_mail_account_folders_account_type
            ON mail_account_folders(mail_account_id, folder_type, canonical_name)`,
    ];
    for (const sql of indexStatements) await runStatement(db, sql);

    return changes;
}
