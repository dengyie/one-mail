/**
 * Durable account lifecycle/tombstone state shared by the gateway and thin shards.
 *
 * This is deliberately shape-driven and additive: old databases may not have the
 * table yet, while a purge retry must remain safe after the metadata row is gone.
 */
export type AccountLifecycleState = "deleting" | "purged";

export type AccountLifecycleRow = {
    account_id: string;
    user_id: number | null;
    username: string | null;
    state: AccountLifecycleState;
};

export const ACCOUNT_LIFECYCLE_INIT_SQL = `
CREATE TABLE IF NOT EXISTS mail_account_lifecycle (
    account_id TEXT PRIMARY KEY,
    user_id INTEGER,
    username TEXT,
    state TEXT NOT NULL CHECK (state IN ('deleting', 'purged')),
    deleting_at INTEGER NOT NULL,
    purged_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mail_account_lifecycle_user ON mail_account_lifecycle(user_id);
CREATE INDEX IF NOT EXISTS idx_mail_account_lifecycle_state ON mail_account_lifecycle(state);
`;

const lifecycleStatements = ACCOUNT_LIFECYCLE_INIT_SQL
    .split(";")
    .map((statement) => statement.replace(/[\r\n]/g, " ").trim())
    .filter(Boolean);

export const ensureAccountLifecycleSchema = async (db: D1Database): Promise<boolean> => {
    for (const statement of lifecycleStatements) await db.prepare(statement).run();
    return true;
};

export const ensureAccountLifecycleTable = async (db: D1Database): Promise<void> => {
    await ensureAccountLifecycleSchema(db);
};

export const lifecycleUpsert = (
    db: D1Database,
    row: { accountId: string; userId?: number | null; username?: string | null; state: AccountLifecycleState; now: number },
) => db.prepare(`
    INSERT INTO mail_account_lifecycle(account_id, user_id, username, state, deleting_at, purged_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
        user_id = COALESCE(excluded.user_id, mail_account_lifecycle.user_id),
        username = COALESCE(excluded.username, mail_account_lifecycle.username),
        state = excluded.state,
        deleting_at = CASE
            WHEN excluded.state = 'deleting' THEN excluded.deleting_at
            ELSE mail_account_lifecycle.deleting_at
        END,
        purged_at = excluded.purged_at
`).bind(
    row.accountId,
    row.userId ?? null,
    row.username ?? null,
    row.state,
    row.now,
    row.state === "purged" ? row.now : null,
);

export const lifecycleRow = async (db: D1Database, accountId: string): Promise<AccountLifecycleRow | null> => {
    try {
        const statement = db.prepare(
            "SELECT account_id, user_id, username, state FROM mail_account_lifecycle WHERE account_id = ?",
        ).bind(accountId) as D1PreparedStatement & { first?: D1PreparedStatement["first"] };
        if (typeof statement.first !== "function") return null;
        const row = await statement.first<AccountLifecycleRow>();
        if (!row || (row.state !== "deleting" && row.state !== "purged")) return null;
        return {
            account_id: String(row.account_id),
            user_id: row.user_id == null ? null : Number(row.user_id),
            username: row.username == null ? null : String(row.username),
            state: row.state as AccountLifecycleState,
        };
    } catch (error) {
        if (/no such table|does not exist/i.test(String(error))) return null;
        throw error;
    }
};

export const lifecycleState = async (db: D1Database, accountId: string): Promise<AccountLifecycleState | null> =>
    (await lifecycleRow(db, accountId))?.state ?? null;
