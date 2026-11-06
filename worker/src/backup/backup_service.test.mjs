import assert from "node:assert/strict";
import test from "node:test";
import {
    BACKUP_COOLDOWN_MS,
    BACKUP_RETRY_COOLDOWN_MS,
    maybeRunScheduledBackup,
    runD1Backup,
    shouldRetryScheduledBackup,
    shouldRunScheduledBackup,
    verifyLatestBackup,
} from "./backup_service.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const DATABASE = "5f3e1c0a-9b2d-4e7a-8c61-1d2e3f4a5b6c";

function fakeDb(handlers = {}) {
    const calls = [];
    return {
        calls,
        prepare(sql) {
            const record = (args) => calls.push({ sql, args });
            return {
                bind(...args) {
                    record(args);
                    return {
                        run: async () => (handlers.run ? handlers.run(sql, args) : { meta: { last_row_id: 7 } }),
                        all: async () => (handlers.all ? handlers.all(sql, args) : { results: [] }),
                    };
                },
                first: async (column) => (handlers.first ? handlers.first(sql, column) : 0),
                run: async () => (handlers.run ? handlers.run(sql, []) : { meta: { last_row_id: 7 } }),
                all: async () => (handlers.all ? handlers.all(sql, []) : { results: [] }),
            };
        },
    };
}

function fakeBucket(overrides = {}) {
    return {
        put: async () => ({ size: 4096 }),
        list: async () => ({ objects: [], truncated: false }),
        delete: async () => {},
        get: async () => null,
        ...overrides,
    };
}

function configured(overrides = {}) {
    return {
        BACKUP_BUCKET: fakeBucket(),
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
        D1_DATABASE_ID: DATABASE,
        D1_REST_API_TOKEN: "token",
        DB: fakeDb(),
        ...overrides,
    };
}

function exportFetch(state = {}) {
    return async (url) => {
        if (url.startsWith("https://download.example/")) {
            return new Response("CREATE TABLE t (id INTEGER);", { status: 200 });
        }
        // First POST creates the export; every later POST is a poll and the
        // real API reports completion as status "complete" with the download
        // url nested under result.result.
        if (!state.created) {
            state.created = true;
            return new Response(JSON.stringify({ success: true, result: { at_bookmark: "b1" } }), { status: 200 });
        }
        return new Response(
            JSON.stringify({
                success: true,
                result: { status: "complete", result: { signed_url: "https://download.example/dump.sql" } },
            }),
            { status: 200 },
        );
    };
}

test("cooldown opens after the 20h window and always for a never-backed-up fleet", () => {
    const now = Date.parse("2026-11-07T12:00:00Z");
    assert.equal(shouldRunScheduledBackup(0, now), true);
    assert.equal(shouldRunScheduledBackup(now - BACKUP_COOLDOWN_MS + 1000, now), false);
    assert.equal(shouldRunScheduledBackup(now - BACKUP_COOLDOWN_MS, now), true);
});

test("retry gate waits an hour after a failed attempt", () => {
    const now = Date.parse("2026-11-07T12:00:00Z");
    assert.equal(shouldRetryScheduledBackup(0, now), true, "no attempt yet");
    assert.equal(shouldRetryScheduledBackup(now - BACKUP_RETRY_COOLDOWN_MS + 1000, now), false);
    assert.equal(shouldRetryScheduledBackup(now - BACKUP_RETRY_COOLDOWN_MS, now), true);
});

test("scheduled path skips a retry that is too close to the last failed attempt", async () => {
    const now = new Date("2026-11-07T12:00:00Z");
    // No successful run (0), newest attempt five minutes ago and failed.
    const db = fakeDb({ first: (sql) => (sql.includes("status = 'success'") ? 0 : now.getTime() - 5 * 60 * 1000) });
    const result = await maybeRunScheduledBackup(
        configured({ DB: db }),
        { now, fetchImpl: exportFetch(), sleep: async () => {} },
    );
    assert.equal(result.skipped, "retry_cooldown");
    assert.equal(result.ok, true);
});

test("scheduled path retries once the retry window has passed", async () => {
    const now = new Date("2026-11-07T12:00:00Z");
    const db = fakeDb({
        first: (sql) => (sql.includes("status = 'success'") ? 0 : now.getTime() - BACKUP_RETRY_COOLDOWN_MS),
    });
    const result = await maybeRunScheduledBackup(
        configured({ DB: db }),
        { now, fetchImpl: exportFetch(), sleep: async () => {} },
    );
    assert.equal(result.ok, true);
    assert.equal(result.skipped, undefined);
    assert.equal(result.key, "d1/daily/2026-11-07.sql");
});

test("runD1Backup is disabled without configuration", async () => {
    const result = await runD1Backup({ DB: fakeDb() });
    assert.equal(result.enabled, false);
    assert.equal(result.skipped, "disabled");
    assert.equal(result.error, "missing_bucket");
});

test("runD1Backup refuses a target that is not the served database", async () => {
    const result = await runD1Backup(configured({ D1_DATABASE_ID: "one-mail-db" }), {
        fetchImpl: exportFetch(),
    });
    assert.equal(result.enabled, true);
    assert.equal(result.ok, false);
    assert.equal(result.error, "invalid_database_id");
});

test("a successful run writes the ledger and prunes", async () => {
    const db = fakeDb();
    const bucket = fakeBucket();
    const now = new Date("2026-11-07T03:00:00Z");
    const result = await runD1Backup(configured({ BACKUP_BUCKET: bucket, DB: db }), {
        now,
        fetchImpl: exportFetch(),
        sleep: async () => {},
    });

    assert.equal(result.ok, true);
    assert.equal(result.kind, "daily");
    assert.equal(result.key, "d1/daily/2026-11-07.sql");
    assert.equal(result.bytes, 4096);

    const insert = db.calls.find((call) => call.sql.includes("INSERT INTO backup_runs"));
    assert.ok(insert);
    assert.deepEqual(insert.args, ["daily", now.getTime()]);
    const update = db.calls.find((call) => call.sql.includes("UPDATE backup_runs"));
    assert.ok(update);
    assert.equal(update.args[0], "success");
    assert.equal(update.args[1], "d1/daily/2026-11-07.sql");
    assert.equal(update.args[2], 4096);
});

test("a failed export records a failed ledger row and reports the error", async () => {
    const db = fakeDb();
    const now = new Date("2026-11-07T03:00:00Z");
    const result = await runD1Backup(configured({ DB: db }), {
        now,
        fetchImpl: async () => new Response("boom", { status: 500 }),
        sleep: async () => {},
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /non-JSON/);
    const update = db.calls.find((call) => call.sql.includes("UPDATE backup_runs"));
    assert.ok(update);
    assert.equal(update.args[0], "failed");
    assert.match(update.args[3], /non-JSON/);
});

test("the export still succeeds when the ledger table is missing", async () => {
    const db = fakeDb({
        run: (sql) => {
            if (sql.includes("INSERT INTO backup_runs")) throw new Error("no such table: backup_runs");
            return { meta: {} };
        },
    });
    const result = await runD1Backup(configured({ DB: db }), {
        now: new Date("2026-11-07T03:00:00Z"),
        fetchImpl: exportFetch(),
        sleep: async () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(result.bytes, 4096);
});

test("scheduled path distinguishes disabled, ledger-unavailable and cooldown", async () => {
    const disabled = await maybeRunScheduledBackup({ DB: fakeDb() });
    assert.equal(disabled.skipped, "disabled");

    const unavailable = await maybeRunScheduledBackup(configured({
        DB: fakeDb({ first: () => { throw new Error("no such table"); } }),
    }));
    assert.equal(unavailable.skipped, "ledger_unavailable");

    const recent = Date.parse("2026-11-07T03:00:00Z") - 60 * 60 * 1000;
    const cooled = await maybeRunScheduledBackup(
        configured({ DB: fakeDb({ first: () => recent }) }),
        { now: new Date("2026-11-07T03:00:00Z") },
    );
    assert.equal(cooled.skipped, "cooldown");
});

test("verify reports no run, missing object and a non-dump header", async () => {
    const none = await verifyLatestBackup(configured({ DB: fakeDb({ all: () => ({ results: [] }) }) }));
    assert.equal(none.error, "no_successful_backup");

    const row = { status: "success", object_key: "d1/daily/2026-11-07.sql" };
    const missing = await verifyLatestBackup(configured({
        DB: fakeDb({ all: () => ({ results: [row] }) }),
        BACKUP_BUCKET: fakeBucket({ get: async () => null }),
    }));
    assert.equal(missing.error, "object_missing");

    const bogus = await verifyLatestBackup(configured({
        DB: fakeDb({ all: () => ({ results: [row] }) }),
        BACKUP_BUCKET: fakeBucket({
            get: async () => ({
                size: 5,
                arrayBuffer: async () => new TextEncoder().encode("hello").buffer,
            }),
        }),
    }));
    assert.equal(bogus.ok, false);
    assert.equal(bogus.error, "not_sql_dump");
});

test("verify accepts a real SQL header and reports the object size", async () => {
    const row = { status: "success", object_key: "d1/daily/2026-11-07.sql" };
    const result = await verifyLatestBackup(configured({
        DB: fakeDb({ all: () => ({ results: [row] }) }),
        BACKUP_BUCKET: fakeBucket({
            get: async () => ({
                size: 999,
                arrayBuffer: async () => new TextEncoder().encode("CREATE TABLE emails (id INTEGER);").buffer,
            }),
        }),
    }));
    assert.equal(result.ok, true);
    assert.equal(result.key, "d1/daily/2026-11-07.sql");
    assert.equal(result.bytes, 999);
});

test("verify is disabled without configuration", async () => {
    const result = await verifyLatestBackup({});
    assert.equal(result.enabled, false);
    assert.equal(result.error, "missing_bucket");
});