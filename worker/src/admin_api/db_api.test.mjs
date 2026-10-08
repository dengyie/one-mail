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
const { ensureTableColumns } = await import("../core/db_schema.ts");
hooks.deregister();

function fixture(t, schema = "") {
    const sqlite = new DatabaseSync(":memory:");
    t.after(() => sqlite.close());
    sqlite.exec(schema);
    const calls = [];
    const db = {
        requests: 0,
        before() {},
        prepare(sql) {
            let args = [];
            const execute = (method, countRequest = true) => {
                if (countRequest) db.requests++;
                calls.push(sql);
                db.before(sql);
                return sqlite.prepare(sql)[method](...args);
            };
            return {
                bind(...values) { args = values; return this; },
                async first(column) { const row = execute("get"); return (column ? row?.[column] : row) ?? null; },
                async all() { return { success: true, results: execute("all") }; },
                async run() { return { success: true, meta: execute("run") }; },
                runInBatch() { return { success: true, meta: execute("run", false) }; },
            };
        },
        async exec(sql) { db.requests++; calls.push(sql); db.before(sql); sqlite.exec(sql); return { count: 1, duration: 0 }; },
        async batch(statements) {
            db.requests++;
            sqlite.exec('BEGIN');
            try {
                const results = statements.map(statement => statement.runInBatch());
                sqlite.exec('COMMIT');
                return results;
            } catch (error) {
                sqlite.exec('ROLLBACK');
                throw error;
            }
        },
    };
    const c = { env: { DB: db }, json: (value, status = 200) => Response.json(value, { status }) };
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

for (const method of ["initialize", "migrate"]) {
    for (const state of ['fresh', 'existing', 'existing-cold', 'legacy']) {
        test(`${method} stays within the free-plan D1 request budget (${state})`, async t => {
            const { c, db } = fixture(t, state === 'legacy' ? legacySchema : '');
            if (state.startsWith('existing')) await api.initialize(c);
            // A new binding identity models a cold Worker with no schemaReady cache.
            if (state === 'existing-cold') c.env.DB = { ...db };
            db.requests = 0;
            await api[method](c);
            t.diagnostic(`${db.requests} D1 requests`);
            assert.ok(db.requests <= 45, `${db.requests} D1 requests leave no room under the 50-request free-plan limit`);
        });
    }
}

test("column batches roll back completely on failure and can be replayed without losing mail", async t => {
    const { c, db, sqlite } = fixture(t, legacySchema);
    const cause = new Error('D1 batch failed');
    db.before = sql => { if (/ALTER TABLE address ADD COLUMN source_meta/.test(sql)) throw cause; };
    await assert.rejects(api.migrate(c), cause);
    assert.ok(!sqlite.prepare('PRAGMA table_info(address)').all().some(row => row.name === 'password'));
    assert.equal(sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(CONSTANTS.DB_VERSION_KEY), undefined);
    db.before = () => {};
    await api.migrate(c);
    assert.equal(sqlite.prepare('SELECT raw FROM raw_mails WHERE id = 1').get().raw, 'original body');
});

for (const complete of [false, true]) {
    test(`a racing column migration is accepted only when all columns exist (${complete})`, async () => {
        const cause = new Error('duplicate column name: password');
        let reads = 0;
        const db = {
            prepare: () => ({ all: async () => ({ results: reads++ ? (complete ? [{ name: 'password' }, { name: 'source_meta' }] : [{ name: 'password' }]) : [] }) }),
            batch: async () => { throw cause; },
        };
        const action = ensureTableColumns(db, 'address', [['password', 'TEXT'], ['source_meta', 'TEXT']]);
        if (complete) assert.deepEqual(await action, []);
        else await assert.rejects(action, cause);
        assert.equal(reads, 2);
    });
}

const legacyUsageIndexes = [
    'idx_emails_order_received', 'idx_emails_read_received', 'idx_emails_star_received',
    'idx_emails_to_order_received', 'idx_emails_to_read_received', 'idx_emails_to_star_received',
];

for (const method of ['initialize', 'migrate']) {
    test(`${method} rejects an oversized index repair before any database mutation`, async t => {
        const { c, sqlite, calls } = fixture(t);
        await api.initialize(c);
        sqlite.exec(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<25000)
            INSERT INTO emails(id, source, from_addr, to_addr, received_at, provider)
            SELECT 'mail-' || n, 'cf_routing', 'sender@example.test', 'receiver@example.test', n, 'native' FROM seq`);
        for (const name of legacyUsageIndexes) sqlite.exec(`DROP INDEX ${name}`);
        sqlite.prepare('DELETE FROM settings WHERE key = ?').run(CONSTANTS.DB_VERSION_KEY);
        calls.length = 0;

        const response = await api[method](c);
        assert.equal(response.status, 409);
        const body = await response.json();
        assert.equal(body.code, 'D1_MIGRATION_WRITE_BUDGET');
        assert.deepEqual(new Set(body.pending_indexes), new Set(legacyUsageIndexes));
        assert.ok(body.index_write_estimate > body.available_write_rows);
        assert.equal(body.estimate_capped, true);
        assert.ok(calls.every(sql => !/\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE|DROP)\b/i.test(sql)));
        assert.equal(sqlite.prepare('SELECT count(*) AS n FROM emails').get().n, 25000);
        assert.equal(sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(CONSTANTS.DB_VERSION_KEY), undefined);
    });
}

test('migration does not rewrite provider=NULL rows that cannot be inferred', async t => {
    const { c, sqlite } = fixture(t);
    await api.initialize(c);
    sqlite.exec(`INSERT INTO emails(id,source,from_addr,to_addr,received_at)
        VALUES('opaque','external_import','sender@example.test','receiver@example.test',1)`);
    const before = sqlite.prepare('SELECT total_changes() AS n').get().n;
    await api.migrate(c);
    assert.equal(sqlite.prepare('SELECT total_changes() AS n').get().n, before);
    assert.equal(sqlite.prepare("SELECT provider FROM emails WHERE id='opaque'").get().provider, null);
});

for (const method of ['initialize', 'migrate']) {
    test(`${method} permits small index repairs and avoids counting already indexed tables`, async t => {
        const { c, sqlite, calls } = fixture(t);
        await api.initialize(c);
        sqlite.exec(`INSERT INTO emails(id, source, from_addr, to_addr, received_at, provider)
            VALUES ('retained', 'cf_routing', 'from@example.test', 'to@example.test', 1, 'native')`);
        for (const name of legacyUsageIndexes) sqlite.exec(`DROP INDEX ${name}`);
        assert.equal((await api[method](c)).status, 200);
        const indexes = new Set(sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='index'").all().map(row => row.name));
        assert.ok(legacyUsageIndexes.every(name => indexes.has(name)));
        assert.equal(sqlite.prepare('SELECT count(*) AS n FROM emails').get().n, 1);
        calls.length = 0;
        assert.equal((await api[method](c)).status, 200);
        assert.ok(calls.every(sql => !/SELECT COUNT\(\*\) AS count FROM \(SELECT 1 FROM emails/.test(sql)));
    });

    test(`${method} performs no DDL when the bounded index preflight read fails`, async t => {
        const { c, sqlite, db, calls } = fixture(t);
        await api.initialize(c);
        sqlite.exec('DROP INDEX idx_emails_order_received');
        calls.length = 0;
        const cause = new Error('D1 read failed during index preflight');
        db.before = sql => { if (/SELECT COUNT\(\*\) AS count/.test(sql)) throw cause; };
        await assert.rejects(api[method](c), cause);
        assert.ok(calls.every(sql => !/\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE|DROP)\b/i.test(sql)));
    });
}
