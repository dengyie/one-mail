import { Context } from "hono";
import { CONSTANTS } from "../constants";
import utils from "../utils";

const DB_INIT_QUERIES = `
CREATE TABLE IF NOT EXISTS raw_mails (
    id INTEGER PRIMARY KEY,
    message_id TEXT,
    source TEXT,
    address TEXT,
    raw TEXT,
    raw_blob BLOB,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_raw_mails_address ON raw_mails(address);

CREATE INDEX IF NOT EXISTS idx_raw_mails_created_at ON raw_mails(created_at);

CREATE INDEX IF NOT EXISTS idx_raw_mails_message_id ON raw_mails(message_id);

CREATE TABLE IF NOT EXISTS address (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    password TEXT,
    source_meta TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_address_name ON address(name);

CREATE INDEX IF NOT EXISTS idx_address_created_at ON address(created_at);

CREATE INDEX IF NOT EXISTS idx_address_updated_at ON address(updated_at);

CREATE INDEX IF NOT EXISTS idx_address_source_meta ON address(source_meta);

CREATE TABLE IF NOT EXISTS auto_reply_mails (
    id INTEGER PRIMARY KEY,
    source_prefix TEXT,
    name TEXT,
    address TEXT UNIQUE,
    subject TEXT,
    message TEXT,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auto_reply_mails_address ON auto_reply_mails(address);

CREATE TABLE IF NOT EXISTS address_sender (
    id INTEGER PRIMARY KEY,
    address TEXT UNIQUE,
    balance INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_address_sender_address ON address_sender(address);

CREATE TABLE IF NOT EXISTS sendbox (
    id INTEGER PRIMARY KEY,
    address TEXT,
    raw TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sendbox_address ON sendbox(address);
CREATE INDEX IF NOT EXISTS idx_sendbox_created_at ON sendbox(created_at);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    user_email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    user_info TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_user_email ON users(user_email);

CREATE TABLE IF NOT EXISTS users_address (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    address_id INTEGER UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_address_user_id ON users_address(user_id);

CREATE INDEX IF NOT EXISTS idx_users_address_address_id ON users_address(address_id);

CREATE TABLE IF NOT EXISTS user_roles (
    id INTEGER PRIMARY KEY,
    user_id INTEGER UNIQUE NOT NULL,
    role_text TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id);

CREATE TABLE IF NOT EXISTS user_passkeys (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    passkey_name TEXT NOT NULL,
    passkey_id TEXT NOT NULL,
    passkey TEXT NOT NULL,
    counter INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_passkeys_user_id ON user_passkeys(user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_passkeys_user_id_passkey_id ON user_passkeys(user_id, passkey_id);

CREATE TABLE IF NOT EXISTS user_mail_accounts (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    label TEXT,
    source TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    username TEXT NOT NULL,
    cred_enc TEXT NOT NULL,
    protocol TEXT DEFAULT 'auto',
    folders_json TEXT,
    oauth_enc TEXT,
    use_ssl INTEGER DEFAULT 1,
    pop3_host TEXT,
    pop3_port INTEGER,
    pop3_ssl INTEGER,
    pop3_use_stls INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1,
    last_sync_at INTEGER,
    last_error TEXT,
    created_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_user_mail_accounts_user ON user_mail_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_user_mail_accounts_username ON user_mail_accounts(username);
CREATE INDEX IF NOT EXISTS idx_user_mail_accounts_enabled ON user_mail_accounts(enabled);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_mail_accounts_username_uq ON user_mail_accounts(username) WHERE enabled = 1;

CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, account_id TEXT, from_addr TEXT NOT NULL,
    to_addr TEXT NOT NULL, subject TEXT, text_body TEXT, html_body TEXT,
    received_at INTEGER NOT NULL, internal_date INTEGER, headers_json TEXT,
    is_read INTEGER DEFAULT 0, flags_json TEXT, attachments_json TEXT, raw_ref TEXT,
    imap_uid TEXT, updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_emails_source ON emails(source);
CREATE INDEX IF NOT EXISTS idx_emails_account ON emails(account_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_to_addr ON emails(to_addr, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_received ON emails(received_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_imap_uid ON emails(imap_uid) WHERE imap_uid IS NOT NULL;

CREATE TABLE IF NOT EXISTS mail_accounts (
    id TEXT PRIMARY KEY, source_type TEXT NOT NULL, name TEXT, config_json TEXT,
    enabled INTEGER DEFAULT 1, last_sync_at INTEGER, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'readonly', allowed_sources TEXT, allowed_accounts TEXT,
    enabled INTEGER DEFAULT 1, created_at INTEGER, last_used_at INTEGER
);
`

async function ensureColumn(db: D1Database, table: string, name: string, definition: string): Promise<boolean> {
    const tableInfo = await db.prepare(`PRAGMA table_info(${table})`).all();
    if ((tableInfo.results ?? []).some((column: any) => column.name === name)) return false;
    try {
        await db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
        return true;
    } catch (error) {
        if (!String(error).toLowerCase().includes('duplicate column')) throw error;
        return false;
    }
}

async function ensureLegacyColumns(db: D1Database): Promise<void> {
    // Version settings can be absent after an interrupted/old deployment. Use
    // the actual table shape rather than assuming the version is authoritative.
    await ensureColumn(db, 'address', 'password', 'TEXT');
    await ensureColumn(db, 'address', 'source_meta', 'TEXT');
    await ensureColumn(db, 'raw_mails', 'metadata', 'TEXT');
    await ensureColumn(db, 'raw_mails', 'raw_blob', 'BLOB');
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_address_source_meta ON address(source_meta)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_raw_mails_message_id ON raw_mails(message_id)`);
}

async function ensurePop3Columns(db: D1Database): Promise<string[]> {
    const tableInfo = await db.prepare(`PRAGMA table_info(user_mail_accounts)`).all();
    const columns = new Set((tableInfo.results ?? []).map((column: any) => column.name));
    const changes: string[] = [];
    const pop3Columns: Array<[string, string]> = [
        ['use_ssl', 'INTEGER DEFAULT 1'],
        ['pop3_host', 'TEXT'],
        ['pop3_port', 'INTEGER'],
        ['pop3_ssl', 'INTEGER'],
        ['pop3_use_stls', 'INTEGER DEFAULT 0'],
    ];
    for (const [name, definition] of pop3Columns) {
        if (columns.has(name)) continue;
        try {
            await db.exec(`ALTER TABLE user_mail_accounts ADD COLUMN ${name} ${definition}`);
            changes.push(name);
            columns.add(name);
        } catch (error) {
            // D1 serializes writes, but two admin requests may have read the
            // same schema. A duplicate-column error means the other request
            // completed this exact step; other failures must be surfaced.
            if (!String(error).toLowerCase().includes('duplicate column')) throw error;
            columns.add(name);
        }
    }
    await db.exec(`UPDATE user_mail_accounts SET use_ssl = 1 WHERE use_ssl IS NULL`);
    await db.exec(`UPDATE user_mail_accounts SET pop3_use_stls = 0 WHERE pop3_use_stls IS NULL`);
    return changes;
}

function initQuery() {
    return DB_INIT_QUERIES.replace(/[\r\n]/g, "")
        .split(";")
        .map((query) => query.trim())
        .join(";\n");
}

export default {
    initialize: async (c: Context<HonoCustomType>) => {
        // CREATE IF NOT EXISTS is safe for both a fresh and an existing D1.
        await c.env.DB.exec(initQuery());
        // CREATE TABLE does not add columns to an old table, so repair the
        // POP3 contract even when db_version is missing or already v0.0.8.
        await ensureLegacyColumns(c.env.DB);
        await ensurePop3Columns(c.env.DB);

        const version = await utils.getSetting(c, CONSTANTS.DB_VERSION_KEY);
        if (version) {
            return c.json({ message: "Database already initialized" });
        }
        await utils.saveSetting(c, CONSTANTS.DB_VERSION_KEY, CONSTANTS.DB_VERSION);
        return c.json({ message: "Database initialized" });
    },
    migrate: async (c: Context<HonoCustomType>) => {
        const version = await utils.getSetting(c, CONSTANTS.DB_VERSION_KEY);

        if (version && version <= "v0.0.2") {
            // migration to v0.0.3: add password column
            const tableInfo = await c.env.DB.prepare(
                `PRAGMA table_info(address)`
            ).all();
            const hasPassword = tableInfo.results?.some(
                (col: any) => col.name === 'password'
            );
            if (!hasPassword) {
                await c.env.DB.exec(`ALTER TABLE address ADD COLUMN password TEXT;`);
            }
        }
        if (version && version <= "v0.0.3") {
            // migration to v0.0.4: add metadata column
            const tableInfo = await c.env.DB.prepare(
                `PRAGMA table_info(raw_mails)`
            ).all();
            const hasMetadata = tableInfo.results?.some(
                (col: any) => col.name === 'metadata'
            );
            if (!hasMetadata) {
                await c.env.DB.exec(`ALTER TABLE raw_mails ADD COLUMN metadata TEXT;`);
            }
        }
        if (version && version <= "v0.0.4") {
            // migration to v0.0.5: add source_meta column
            const tableInfo = await c.env.DB.prepare(
                `PRAGMA table_info(address)`
            ).all();
            const hasSourceMeta = tableInfo.results?.some(
                (col: any) => col.name === 'source_meta'
            );
            if (!hasSourceMeta) {
                await c.env.DB.exec(`ALTER TABLE address ADD COLUMN source_meta TEXT;`);
                await c.env.DB.exec(`CREATE INDEX IF NOT EXISTS idx_address_source_meta ON address(source_meta);`);
            }
        }
        if (version && version <= "v0.0.5") {
            // migration to v0.0.6: add message_id index on raw_mails
            await c.env.DB.exec(`CREATE INDEX IF NOT EXISTS idx_raw_mails_message_id ON raw_mails(message_id);`);
        }
        if (version && version <= "v0.0.6") {
            // migration to v0.0.7: add raw_blob column for gzip compressed email storage
            const tableInfo = await c.env.DB.prepare(
                `PRAGMA table_info(raw_mails)`
            ).all();
            const hasRawBlob = tableInfo.results?.some(
                (col: any) => col.name === 'raw_blob'
            );
            if (!hasRawBlob) {
                await c.env.DB.exec(`ALTER TABLE raw_mails ADD COLUMN raw_blob BLOB;`);
            }
        }
        // Finish legacy migrations before exposing the current schema. The
        // init DDL creates missing tables, while these checks repair columns on
        // tables that already existed (CREATE IF NOT EXISTS cannot).
        await c.env.DB.exec(initQuery());
        await ensureLegacyColumns(c.env.DB);
        const migrationChanges = await ensurePop3Columns(c.env.DB);
        if (version != CONSTANTS.DB_VERSION || migrationChanges.length > 0) {
            await utils.saveSetting(c, CONSTANTS.DB_VERSION_KEY, CONSTANTS.DB_VERSION);
            return c.json({
                success: true,
                message: "Database migrated"
            });
        }
        return c.json({
            success: true,
            message: "Database does not need migration"
        });
    },
    getVersion: async (c: Context<HonoCustomType>) => {
        const version = await utils.getSetting(c, CONSTANTS.DB_VERSION_KEY);
        return c.json({
            need_initialization: !version,
            need_migration: version && version != CONSTANTS.DB_VERSION,
            current_db_version: version,
            code_db_version: CONSTANTS.DB_VERSION
        });
    },
}
