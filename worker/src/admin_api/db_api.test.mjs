import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// Exercise the real handlers and schema repairs, with SQLite at the D1 boundary.
const hooks = registerHooks({ resolve(specifier, context, next) {
    try { return next(specifier, context); }
    catch (cause) {
        if (!specifier.startsWith(".")) throw cause;
        for (const suffix of [".ts", "/index.ts"]) {
            const target = new URL(specifier + suffix, context.parentURL);
            if (existsSync(target)) return next(target.href, context);
        }
        throw cause;
    }
} });
const { default: api } = await import("./db_api.ts");
const { CONSTANTS } = await import("../constants.ts");
hooks.deregister();

function fixture(t, schema = "") {
    const sqlite = new DatabaseSync(":memory:");
    t.after(() => sqlite.close());
    sqlite.exec(schema);
    const calls = [];
    const db = {
        before() {},
        prepare(sql) {
            let args = [];
            const execute = (method) => {
                calls.push(sql);
                db.before(sql);
                return sqlite.prepare(sql)[method](...args);
            };
            return {
                bind(...values) { args = values; return this; },
                async first(column) { const row = execute("get"); return (column ? row?.[column] : row) ?? null; },
                async all() { return { success: true, results: execute("all") }; },
                async run() { return { success: true, meta: execute("run") }; },
            };
        },
        async exec(sql) { calls.push(sql); db.before(sql); sqlite.exec(sql); return { count: 1, duration: 0 }; },
    };
    const c = { env: { DB: db }, json: value => Response.json(value) };
    return { sqlite, db, c, calls };
}

const settingsSchema = `CREATE TABLE settings (
    key TEXT PRIMARY KEY, value TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);`;
const expected = (need_initialization, need_migration, current_db_version = null) => ({
    need_initialization, need_migration, current_db_version,
    code_db_version: CONSTANTS.DB_VERSION,
});

test("an empty D1 needs initialization and always returns boolean flags", async t => {
    const { c } = fixture(t, "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT);");
    assert.deepEqual(await (await api.getVersion(c)).json(), expected(true, false));
});

for (const table of ["settings", "raw_mails", "address", "users", "emails", "user_mail_accounts", "sendbox"]) {
    test(`existing ${table} without a version record requires migration, not initialization`, async t => {
        const schema = table === "settings" ? settingsSchema : `CREATE TABLE ${table} (id TEXT PRIMARY KEY);`;
        const { c, calls } = fixture(t, schema);
        assert.deepEqual(await (await api.getVersion(c)).json(), expected(false, true));
        assert.ok(calls.length <= 2, "status must use bounded metadata and key lookups");
        assert.ok(calls.every(sql => !/FROM\s+(?:emails|raw_mails|users|sendbox|user_mail_accounts|address)\b/i.test(sql)));
    });
}

for (const version of [null, "", "v0.0.2", CONSTANTS.DB_VERSION]) {
    test(`version record ${JSON.stringify(version)} has an unambiguous status`, async t => {
        const { c, sqlite } = fixture(t, settingsSchema);
        sqlite.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(CONSTANTS.DB_VERSION_KEY, version);
        assert.deepEqual(await (await api.getVersion(c)).json(),
            expected(false, version !== CONSTANTS.DB_VERSION, version || null));
    });
}

for (const stage of ["schema", "version"]) {
    test(`status propagates ${stage} read errors with their cause`, async t => {
        const { c, db } = fixture(t, settingsSchema);
        const cause = new Error("D1 read unavailable");
        db.before = sql => { if (stage === "schema" || /SELECT\s+value\s+FROM\s+settings/i.test(sql)) throw cause; };
        await assert.rejects(api.getVersion(c), error => {
            assert.equal(error.cause, cause);
            return true;
        });
    });
}

for (const method of ["initialize", "migrate"]) {
    test(`${method} stops before DDL when the version cannot be read`, async t => {
        const { c, db, calls } = fixture(t, settingsSchema);
        const cause = new Error("D1 read unavailable");
        db.before = sql => { if (/SELECT\s+value\s+FROM\s+settings/i.test(sql)) throw cause; };
        await assert.rejects(api[method](c), error => { assert.equal(error.cause, cause); return true; });
        assert.ok(calls.every(sql => !/\b(?:CREATE|ALTER|INSERT|UPDATE)\b/i.test(sql)));
    });
}

test("shard status keeps its existing contract without querying D1", async () => {
    const c = { env: { SHARD_MODE: "1" }, json: value => Response.json(value) };
    assert.deepEqual(await (await api.getVersion(c)).json(), expected(false, false, "shard"));
});

const legacySchema = `
CREATE TABLE address (id INTEGER PRIMARY KEY, name TEXT UNIQUE, created_at TEXT, updated_at TEXT);
CREATE TABLE raw_mails (id INTEGER PRIMARY KEY, message_id TEXT, source TEXT, address TEXT, raw TEXT, created_at TEXT);
INSERT INTO address VALUES (1, 'retained@example.com', '2026-01-01', '2026-01-01');
INSERT INTO raw_mails VALUES (1, 'original-id', 'test', 'retained@example.com', 'original body', '2026-01-01');
`;

for (const method of ["initialize", "migrate"]) {
    test(`${method} repairs a legacy schema with no version and preserves stored mail`, async t => {
        const { c, sqlite } = fixture(t, legacySchema);
        await api[method](c);
        await api[method](c);
        assert.deepEqual(await (await api.getVersion(c)).json(), expected(false, false, CONSTANTS.DB_VERSION));
        assert.equal(sqlite.prepare("SELECT raw FROM raw_mails WHERE id = 1").get().raw, "original body");
        assert.equal(sqlite.prepare("SELECT name FROM address WHERE id = 1").get().name, "retained@example.com");
        const columns = new Set(sqlite.prepare("PRAGMA table_info(address)").all().map(row => row.name));
        assert.ok(columns.has("source_meta") && columns.has("password"));
    });
}

for (const version of ["v0.0.1", "v0.0.2", "v0.0.3", "v0.0.4", "v0.0.5", "v0.0.6"]) {
    test(`migration repairs actual columns from ${version} and can be replayed`, async t => {
        const { c, sqlite } = fixture(t, legacySchema + settingsSchema);
        sqlite.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(CONSTANTS.DB_VERSION_KEY, version);
        await api.migrate(c);
        await api.migrate(c);
        assert.deepEqual(await (await api.getVersion(c)).json(), expected(false, false, CONSTANTS.DB_VERSION));
        assert.equal(sqlite.prepare("SELECT raw FROM raw_mails WHERE id = 1").get().raw, "original body");
        for (const [table, column] of [["address", "password"], ["address", "source_meta"], ["raw_mails", "raw_blob"], ["raw_mails", "metadata"]]) {
            assert.ok(sqlite.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column));
        }
    });
}

test("a failed schema repair never publishes the current version", async t => {
    const { c, db, sqlite } = fixture(t);
    const cause = new Error("D1 write unavailable");
    db.before = sql => { if (/CREATE UNIQUE INDEX IF NOT EXISTS idx_user_passkeys_passkey_id/.test(sql)) throw cause; };
    await assert.rejects(api.migrate(c), cause);
    assert.equal(sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(CONSTANTS.DB_VERSION_KEY), undefined);
});
