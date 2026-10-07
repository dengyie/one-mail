import assert from "node:assert/strict";
import test from "node:test";
import {
    addQuotaDelta,
    attachD1Quota,
    d1QuotaKvKey,
    D1_QUOTA_FLUSH_INTERVAL_MS,
    D1_QUOTA_ATTEMPT_INTERVAL_MS,
    flushD1Quota,
    maybeFlushD1Quota,
    QuotaTelemetryError,
    isShardMode,
    metaDelta,
    peekD1QuotaPendingForTests,
    percentOf,
    recordD1Quota,
    resetD1QuotaStateForTests,
    resolveShardId,
    utcDateOf,
    viewD1Quota,
    wrapD1,
} from "./d1_quota.ts";

const makeClock = (ms) => ({
    now: () => ms,
    advance: (delta) => { ms += delta; },
});

const makeKv = (store = new Map()) => ({
    store,
    gets: [],
    puts: [],
    async get(key) {
        this.gets.push(key);
        return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, options) {
        this.puts.push({ key, value, options });
        store.set(key, value);
    },
});

const snapshot = (now, overrides = {}) => ({
    v: 1,
    shard_id: "primary",
    utc_date: utcDateOf(now),
    rows_read: 100,
    rows_written: 2,
    flushed_at: now,
    flush_count: 1,
    ...overrides,
});

const assertTelemetryError = (error, operation, cause, date = "2026-10-04") => {
    assert.ok(error instanceof QuotaTelemetryError);
    assert.equal(error.name, "QuotaTelemetryError");
    assert.equal(error.operation, operation);
    assert.equal(error.shard_id, "primary");
    assert.equal(error.utc_date, date);
    assert.equal(error.key, d1QuotaKvKey(date));
    if (cause !== undefined) assert.equal(error.cause, cause);
    assert.match(error.message, /primary/);
    assert.match(error.stack, /QuotaTelemetryError/);
    return true;
};

const makeStmt = ({ rows = [], meta = { rows_read: 4, rows_written: 1 } } = {}) => {
    const stmt = {
        bind(..._args) {
            assert.equal(this, stmt);
            return stmt;
        },
        async all() {
            assert.equal(this, stmt);
            return { results: rows, meta, success: true };
        },
        async run() {
            assert.equal(this, stmt);
            return { success: true, meta };
        },
        async first(col) {
            const row = rows[0] ?? null;
            if (row == null) return null;
            return col ? row[col] : row;
        },
        async raw() {
            return rows.map((row) => Object.values(row));
        },
    };
    return stmt;
};

test("utcDateOf is always the UTC calendar day", () => {
    assert.equal(utcDateOf(Date.UTC(2026, 9, 4, 23, 30, 0)), "2026-10-04");
    assert.equal(utcDateOf(Date.UTC(2026, 9, 5, 0, 0, 0)), "2026-10-05");
    assert.equal(d1QuotaKvKey("2026-10-04"), "one-mail:d1quota:2026-10-04");
});

test("metaDelta keeps numeric shape while invalid meta is excluded and flagged", () => {
    assert.deepEqual(metaDelta(undefined), { rows_read: 0, rows_written: 0 });
    assert.deepEqual(metaDelta({ rows_read: 12.9, rows_written: -3 }), { rows_read: 0, rows_written: 0 });
});

test("percentOf clamps to 0..100 at one decimal", () => {
    assert.equal(percentOf(0, 5_000_000), 0);
    assert.equal(percentOf(2_500_000, 5_000_000), 50);
    assert.equal(percentOf(9_000_000, 5_000_000), 100);
    assert.equal(percentOf(1, 0), 0);
});

test("isShardMode accepts 1/true and resolveShardId defaults to primary", () => {
    assert.equal(isShardMode({ SHARD_MODE: "1" }), true);
    assert.equal(isShardMode({ SHARD_MODE: "true" }), true);
    assert.equal(isShardMode({ SHARD_MODE: true }), true);
    assert.equal(isShardMode({}), false);
    assert.equal(resolveShardId({}), "primary");
    assert.equal(resolveShardId({ SHARD_ID: " shard1 " }), "shard1");
});

test("wrapD1 records all()/run()/first() via all() so COUNT paths keep meta", async () => {
    resetD1QuotaStateForTests();
    const innerStmt = makeStmt({
        rows: [{ count: 7, id: "a" }],
        meta: { rows_read: 91, rows_written: 0 },
    });
    innerStmt.run = async () => ({ success: true, meta: { rows_read: 91, rows_written: 1 } });
    const db = wrapD1({
        prepare() {
            return innerStmt;
        },
        async batch() {
            return [];
        },
        async exec() {
            return { count: 0, duration: 0 };
        },
        async dump() {
            return new ArrayBuffer(0);
        },
    });

    const count = await db.prepare("SELECT count(*) as count FROM emails").first("count");
    assert.equal(count, 7);
    assert.deepEqual(peekD1QuotaPendingForTests(), { rows_read: 91, rows_written: 0 });

    await db.prepare("SELECT 1").all();
    await db.prepare("UPDATE emails SET is_read = 1").run();
    assert.equal(peekD1QuotaPendingForTests().rows_read, 91 + 91 + 91);
    assert.equal(peekD1QuotaPendingForTests().rows_written, 1);
});

test("wrapD1 batch unwraps statements and sums each result meta", async () => {
    resetD1QuotaStateForTests();
    const innerA = makeStmt({ meta: { rows_read: 2, rows_written: 1 } });
    const innerB = makeStmt({ meta: { rows_read: 3, rows_written: 4 } });
    const originals = [innerA, innerB];
    let received = null;
    const db = wrapD1({
        prepare() {
            return originals.shift();
        },
        async batch(statements) {
            received = statements;
            return [
                { success: true, meta: { rows_read: 2, rows_written: 1 } },
                { success: true, meta: { rows_read: 3, rows_written: 4 } },
            ];
        },
        async exec() {
            return { count: 0, duration: 0 };
        },
        async dump() {
            return new ArrayBuffer(0);
        },
    });
    const a = db.prepare("A").bind(1);
    const b = db.prepare("B").bind(2);
    await db.batch([a, b]);
    assert.equal(received[0], innerA);
    assert.equal(received[1], innerB);
    assert.deepEqual(peekD1QuotaPendingForTests(), { rows_read: 5, rows_written: 5 });
});

test("flush is skipped when another isolate wrote within the five minute window", async () => {
    const t0 = Date.UTC(2026, 9, 4, 12, 0, 0);
    resetD1QuotaStateForTests(makeClock(t0));
    const kv = makeKv();
    const key = d1QuotaKvKey("2026-10-04");
    await kv.put(key, JSON.stringify({
        v: 1,
        shard_id: "primary",
        utc_date: "2026-10-04",
        rows_read: 100,
        rows_written: 2,
        flushed_at: t0 - 1_000,
        flush_count: 1,
    }));
    recordD1Quota({ rows_read: 50, rows_written: 3 });
    const env = { KV: kv, SHARD_ID: "primary" };
    const flushed = await flushD1Quota(env);
    assert.equal(flushed.rows_read, 100);
    assert.deepEqual(peekD1QuotaPendingForTests(), { rows_read: 50, rows_written: 3 });
});

test("flush commits pending once the observed snapshot interval has elapsed", async () => {
    const t0 = Date.UTC(2026, 9, 4, 12, 0, 0);
    resetD1QuotaStateForTests(makeClock(t0));
    const kv = makeKv();
    const key = d1QuotaKvKey("2026-10-04");
    await kv.put(key, JSON.stringify({
        v: 1,
        shard_id: "primary",
        utc_date: "2026-10-04",
        rows_read: 100,
        rows_written: 2,
        flushed_at: t0 - D1_QUOTA_FLUSH_INTERVAL_MS - 1,
        flush_count: 4,
    }));
    recordD1Quota({ rows_read: 50, rows_written: 3 });
    const flushed = await flushD1Quota({ KV: kv, SHARD_ID: "primary" });
    assert.equal(flushed.rows_read, 150);
    assert.equal(flushed.rows_written, 5);
    assert.equal(flushed.flush_count, 5);
    assert.deepEqual(peekD1QuotaPendingForTests(), { rows_read: 0, rows_written: 0 });
});

test("viewD1Quota reports best-effort KV aggregation explicitly", async () => {
    const t0 = Date.UTC(2026, 9, 4, 8, 0, 0);
    resetD1QuotaStateForTests(makeClock(t0));
    const kv = makeKv();
    await kv.put(d1QuotaKvKey("2026-10-04"), JSON.stringify({
        v: 1,
        shard_id: "primary",
        utc_date: "2026-10-04",
        rows_read: 1_000,
        rows_written: 10,
        flushed_at: t0,
        flush_count: 2,
    }));
    recordD1Quota({ rows_read: 20, rows_written: 1 });
    const view = await viewD1Quota({ KV: kv });
    assert.equal(view.rows_read, 1_020);
    assert.equal(view.rows_written, 11);
    assert.equal(view.pending_unflushed.rows_read, 20);
    assert.equal(view.utc_date, "2026-10-04");
    assert.equal(view.rows_read_limit, 5_000_000);
    assert.equal(view.aggregation_mode, "best_effort_kv");
});

test("attachD1Quota leaves env unchanged when DB is missing", () => {
    const env = { KV: makeKv() };
    assert.equal(attachD1Quota(env), env);
});

test("addQuotaDelta mutates the target in place", () => {
    const target = { rows_read: 1, rows_written: 2 };
    addQuotaDelta(target, { rows_read: 3, rows_written: 4 });
    assert.deepEqual(target, { rows_read: 4, rows_written: 6 });
});

test("first preserves null, falsy values, rows, and D1 missing-column errors without extra queries", async () => {
    resetD1QuotaStateForTests();
    const rows = [{ nullable: null, zero: 0, empty: "", bool: false }];
    const stmt = makeStmt({ rows });
    let queries = 0;
    const all = stmt.all;
    stmt.all = function () { queries++; return all.call(this); };
    stmt.first = () => assert.fail("native first must not run a second query");
    const wrapped = wrapD1({ prepare: () => stmt }).prepare("SELECT ...").bind(1);
    assert.equal(await wrapped.first(), rows[0]);
    for (const col of Object.keys(rows[0])) assert.equal(await wrapped.first(col), rows[0][col]);
    for (const col of ["missing", "", null]) {
        await assert.rejects(wrapped.first(col), (error) => {
            assert.equal(error.message, `D1_COLUMN_NOTFOUND: Column not found (${col})`);
            assert.equal(error.cause.message, "Column not found");
            return true;
        });
    }
    assert.equal(queries, 8);
    assert.deepEqual(peekD1QuotaPendingForTests(), { rows_read: 32, rows_written: 8 });
    rows.length = 0;
    assert.equal(await wrapped.first("missing"), null);
    assert.equal(queries, 9);
});

test("all/run bind their target even when detached and forward arguments", async () => {
    resetD1QuotaStateForTests();
    const stmt = makeStmt();
    stmt.all = async function (...args) {
        assert.equal(this, stmt);
        assert.deepEqual(args, ["all arg"]);
        return { meta: { rows_read: 3 }, results: [] };
    };
    stmt.run = async function (...args) {
        assert.equal(this, stmt);
        assert.deepEqual(args, ["run arg"]);
        return { meta: { rows_written: 2 } };
    };
    const wrapped = wrapD1({ prepare: () => stmt }).prepare("SQL");
    const { all, run } = wrapped;
    await all("all arg");
    await run("run arg");
    assert.deepEqual(peekD1QuotaPendingForTests(), { rows_read: 3, rows_written: 2 });
});

test("D1 query errors propagate unchanged and are not counted as successful queries", async () => {
    resetD1QuotaStateForTests();
    const cause = new Error("D1 unavailable");
    const stmt = makeStmt();
    stmt.all = stmt.run = async () => { throw cause; };
    const db = wrapD1({ prepare: () => stmt, batch: async () => { throw cause; } });
    const wrapped = db.prepare("SQL");
    for (const op of [() => wrapped.first(), () => wrapped.all(), () => wrapped.run(), () => db.batch([wrapped])]) {
        await assert.rejects(op(), (error) => error === cause);
    }
    assert.deepEqual(peekD1QuotaPendingForTests(), { rows_read: 0, rows_written: 0 });
});

test("UTC rollover excludes yesterday pending from today's view and drains one day per window", async () => {
    const clock = makeClock(Date.UTC(2026, 9, 4, 23, 59, 59));
    resetD1QuotaStateForTests(clock);
    const kv = makeKv();
    const env = { KV: kv };
    recordD1Quota({ rows_read: 50, rows_written: 3 });
    clock.advance(1_000);
    recordD1Quota({ rows_read: 7, rows_written: 1 });
    const view = await viewD1Quota(env);
    assert.equal(view.utc_date, "2026-10-05");
    assert.equal(view.rows_read, 7);
    assert.deepEqual(view.pending_unflushed, { rows_read: 7, rows_written: 1 });
    const returned = await flushD1Quota(env, { force: true });
    assert.equal(returned.utc_date, "2026-10-05");
    assert.equal(returned.rows_read, 0);
    assert.equal(kv.puts.length, 1);
    assert.equal(kv.puts[0].key, d1QuotaKvKey("2026-10-04"));
    assert.equal(JSON.parse(kv.puts[0].value).rows_read, 50);
    assert.deepEqual(peekD1QuotaPendingForTests("2026-10-04"), { rows_read: 0, rows_written: 0 });
    await flushD1Quota(env, { force: true });
    assert.equal(kv.puts.length, 1);
    clock.advance(D1_QUOTA_FLUSH_INTERVAL_MS);
    const today = await flushD1Quota(env);
    assert.equal(today.rows_read, 7);
    assert.equal(kv.puts.length, 2);
    assert.equal(kv.puts[1].key, d1QuotaKvKey("2026-10-05"));
    assert.equal(kv.puts[1].options.expirationTtl, 3 * 24 * 60 * 60);
});

test("successful-write throttle spans midnight even if today's KV key is missing", async () => {
    const clock = makeClock(Date.UTC(2026, 9, 4, 23, 59, 59));
    resetD1QuotaStateForTests(clock);
    const kv = makeKv();
    recordD1Quota({ rows_read: 5, rows_written: 0 });
    await flushD1Quota({ KV: kv });
    clock.advance(1_000);
    recordD1Quota({ rows_read: 9, rows_written: 0 });
    await flushD1Quota({ KV: kv }, { force: true });
    assert.equal(kv.puts.length, 1);
    assert.equal((await viewD1Quota({ KV: kv })).rows_read, 9);
    clock.advance(D1_QUOTA_FLUSH_INTERVAL_MS - 1_000);
    await flushD1Quota({ KV: kv }, { force: true });
    assert.equal(kv.puts.length, 2);
});

test("force obeys both observed remote throttle and local 300s throttle under stale KV", async () => {
    const t0 = Date.UTC(2026, 9, 4, 12);
    const clock = makeClock(t0);
    resetD1QuotaStateForTests(clock);
    const stale = JSON.stringify(snapshot(t0 - 1_000));
    const kv = makeKv(new Map([[d1QuotaKvKey("2026-10-04"), stale]]));
    kv.get = async function (key) { this.gets.push(key); return stale; };
    const env = { KV: kv };
    recordD1Quota({ rows_read: 50, rows_written: 3 });
    await flushD1Quota(env, { force: true });
    assert.equal(kv.puts.length, 0);
    clock.advance(D1_QUOTA_FLUSH_INTERVAL_MS - 1_000);
    const first = await flushD1Quota(env, { force: true });
    assert.equal(first.rows_read, 150);
    assert.equal(first.rows_written, 5);
    assert.equal(kv.gets.length, 2, "no read after successful put");
    recordD1Quota({ rows_read: 10, rows_written: 2 });
    first.rows_read = 0; // Returned snapshots cannot mutate the local cache.
    for (const elapsed of [0, 30_000, 60_000, D1_QUOTA_FLUSH_INTERVAL_MS - 90_001]) {
        clock.advance(elapsed);
        assert.equal((await flushD1Quota(env, { force: true })).rows_read, 150);
        assert.equal(kv.puts.length, 1);
    }
    const view = await viewD1Quota(env);
    assert.equal(view.rows_read, 160);
    assert.equal(view.rows_written, 7);
    clock.advance(1);
    const second = await flushD1Quota(env, { force: true });
    assert.equal(second.rows_read, 160);
    assert.equal(second.rows_written, 7);
    assert.equal(second.flush_count, 3);
    assert.equal(kv.puts.length, 2);
    assert.deepEqual(peekD1QuotaPendingForTests(), { rows_read: 0, rows_written: 0 });
});

test("lastKnown snapshot merges each counter monotonically when KV has newer external counts", async () => {
    const t0 = Date.UTC(2026, 9, 4, 12);
    const clock = makeClock(t0);
    resetD1QuotaStateForTests(clock);
    const kv = makeKv();
    const env = { KV: kv };
    recordD1Quota({ rows_read: 50, rows_written: 5 });
    await flushD1Quota(env);
    kv.store.set(d1QuotaKvKey("2026-10-04"), JSON.stringify(snapshot(t0, { rows_read: 80, rows_written: 1 })));
    clock.advance(D1_QUOTA_FLUSH_INTERVAL_MS);
    recordD1Quota({ rows_read: 3, rows_written: 2 });
    const result = await flushD1Quota(env);
    assert.equal(result.rows_read, 83);
    assert.equal(result.rows_written, 7);
});

test("concurrent flushes share one KV put and preserve records made during I/O", async () => {
    const clock = makeClock(Date.UTC(2026, 9, 4, 12));
    resetD1QuotaStateForTests(clock);
    const kv = makeKv();
    let release, entered;
    const blocked = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    const put = kv.put;
    kv.put = async function (...args) { entered(); await blocked; return put.apply(this, args); };
    recordD1Quota({ rows_read: 10, rows_written: 1 });
    const env = { KV: kv };
    const first = flushD1Quota(env);
    await started;
    const others = Array.from({ length: 20 }, () => flushD1Quota(env, { force: true }));
    recordD1Quota({ rows_read: 7, rows_written: 2 });
    assert.equal((await viewD1Quota(env)).rows_read, 17);
    release();
    for (const result of await Promise.all([first, ...others])) assert.equal(result.rows_read, 10);
    assert.equal(kv.puts.length, 1);
    assert.deepEqual(peekD1QuotaPendingForTests(), { rows_read: 7, rows_written: 2 });
    assert.equal((await viewD1Quota(env)).rows_read, 17);
    clock.advance(D1_QUOTA_FLUSH_INTERVAL_MS);
    assert.equal((await flushD1Quota(env)).rows_read, 17);
    assert.equal(kv.puts.length, 2);
});

test("slow successful put starts local throttle at completion and keeps midnight records separate", async () => {
    const clock = makeClock(Date.UTC(2026, 9, 4, 23, 59, 59));
    resetD1QuotaStateForTests(clock);
    const kv = makeKv();
    const put = kv.put;
    kv.put = async function (...args) {
        clock.advance(180_000);
        recordD1Quota({ rows_read: 9, rows_written: 1 });
        return put.apply(this, args);
    };
    recordD1Quota({ rows_read: 10, rows_written: 2 });
    const result = await flushD1Quota({ KV: kv });
    assert.equal(result.utc_date, "2026-10-04");
    assert.equal(result.rows_read, 10);
    assert.equal((await viewD1Quota({ KV: kv })).rows_read, 9);
    await flushD1Quota({ KV: kv }, { force: true });
    assert.equal(kv.puts.length, 1);
    assert.deepEqual(peekD1QuotaPendingForTests(), { rows_read: 9, rows_written: 1 });
});

test("KV get errors preserve cause, reject flush/view, retain pending and perform no writes", async () => {
    resetD1QuotaStateForTests(makeClock(Date.UTC(2026, 9, 4, 12)));
    const cause = new Error("KV get failed", { cause: new Error("network root") });
    const kv = makeKv();
    kv.get = async () => { throw cause; };
    recordD1Quota({ rows_read: 4, rows_written: 1 });
    await assert.rejects(flushD1Quota({ KV: kv }), (error) => assertTelemetryError(error, "get", cause));
    await assert.rejects(viewD1Quota({ KV: kv }), (error) => assertTelemetryError(error, "get", cause));
    assert.equal(kv.puts.length, 0);
    assert.deepEqual(peekD1QuotaPendingForTests(), { rows_read: 4, rows_written: 1 });
    kv.get = async () => null;
    assert.equal((await flushD1Quota({ KV: kv })).rows_read, 4);
    assert.equal(kv.puts.length, 1);
});

test("failed KV put retains all in-flight counts, shares rejection and permits a later retry", async () => {
    resetD1QuotaStateForTests(makeClock(Date.UTC(2026, 9, 4, 12)));
    const cause = new Error("KV put failed", { cause: new Error("root") });
    const kv = makeKv();
    let attempts = 0;
    const put = kv.put;
    kv.put = async () => {
        attempts++;
        recordD1Quota({ rows_read: 3, rows_written: 2 });
        throw cause;
    };
    recordD1Quota({ rows_read: 10, rows_written: 1 });
    const env = { KV: kv };
    const results = await Promise.allSettled([flushD1Quota(env), flushD1Quota(env, { force: true })]);
    assert.equal(attempts, 1);
    assert.equal(results[0].status, "rejected");
    assert.equal(results[1].reason, results[0].reason);
    assertTelemetryError(results[0].reason, "put", cause);
    assert.deepEqual(peekD1QuotaPendingForTests(), { rows_read: 13, rows_written: 3 });
    assert.equal(kv.puts.length, 0);
    kv.put = put;
    const retry = await flushD1Quota(env);
    assert.equal(retry.rows_read, 13);
    assert.equal(retry.rows_written, 3);
    assert.equal(retry.flush_count, 1);
    assert.equal(kv.puts.length, 1);
});

test("only missing KV key is zero; malformed JSON and invalid schemas fail loudly without put", async () => {
    const t0 = Date.UTC(2026, 9, 4, 12);
    const invalid = [
        "", "{broken", "null", "[]", "{}", "0",
        JSON.stringify(snapshot(t0, { v: 2 })),
        JSON.stringify(snapshot(t0, { utc_date: "2026-10-03" })),
        JSON.stringify(snapshot(t0, { shard_id: "other" })),
        ...["rows_read", "rows_written", "flushed_at", "flush_count"].flatMap((field) =>
            [undefined, "1", -1, 1.5, null, 1e30].map((value) => JSON.stringify(snapshot(t0, { [field]: value })))),
    ];
    for (const raw of invalid) {
        resetD1QuotaStateForTests(makeClock(t0));
        const kv = makeKv(new Map([[d1QuotaKvKey("2026-10-04"), raw]]));
        recordD1Quota({ rows_read: 6, rows_written: 1 });
        const check = (error) => {
            assertTelemetryError(error, "parse");
            assert.ok(error.cause instanceof SyntaxError || error.cause instanceof TypeError);
            assert.ok(error.cause.stack);
            return true;
        };
        await assert.rejects(flushD1Quota({ KV: kv }), check);
        await assert.rejects(viewD1Quota({ KV: kv }), check);
        assert.equal(kv.puts.length, 0);
        assert.deepEqual(peekD1QuotaPendingForTests(), { rows_read: 6, rows_written: 1 });
    }
    resetD1QuotaStateForTests(makeClock(t0));
    assert.equal((await viewD1Quota({ KV: makeKv() })).rows_read, 0);
});

test("invalid KV snapshot is not hidden by an existing lastKnown cache", async () => {
    const clock = makeClock(Date.UTC(2026, 9, 4, 12));
    resetD1QuotaStateForTests(clock);
    const kv = makeKv();
    recordD1Quota({ rows_read: 10, rows_written: 1 });
    await flushD1Quota({ KV: kv });
    recordD1Quota({ rows_read: 2, rows_written: 0 });
    kv.store.set(d1QuotaKvKey("2026-10-04"), "invalid");
    clock.advance(D1_QUOTA_FLUSH_INTERVAL_MS);
    await assert.rejects(flushD1Quota({ KV: kv }), (error) => assertTelemetryError(error, "parse"));
    assert.equal(kv.puts.length, 1);
    assert.deepEqual(peekD1QuotaPendingForTests(), { rows_read: 2, rows_written: 0 });
});

test("maybeFlush uses 30s attempt throttle and schedules failures for entrypoint handling", async () => {
    const clock = makeClock(0);
    resetD1QuotaStateForTests(clock);
    const cause = new Error("get failed");
    const kv = makeKv();
    kv.get = async () => { throw cause; };
    const scheduled = [];
    const ctx = { waitUntil: (promise) => { scheduled.push(promise); } };
    const env = { KV: kv };
    maybeFlushD1Quota(env, ctx);
    assert.equal(scheduled.length, 0);
    recordD1Quota({ rows_read: 4, rows_written: 0 });
    maybeFlushD1Quota(env, ctx);
    await assert.rejects(scheduled[0], (error) => assertTelemetryError(error, "get", cause, "1970-01-01"));
    maybeFlushD1Quota(env, ctx);
    clock.advance(D1_QUOTA_ATTEMPT_INTERVAL_MS - 1);
    maybeFlushD1Quota(env, ctx);
    assert.equal(scheduled.length, 1);
    clock.advance(1);
    kv.get = async () => null;
    maybeFlushD1Quota(env, ctx);
    await scheduled[1];
    recordD1Quota({ rows_read: 1, rows_written: 0 });
    clock.advance(D1_QUOTA_ATTEMPT_INTERVAL_MS);
    maybeFlushD1Quota(env, ctx);
    assert.equal(scheduled.length, 2, "attempt timer must not bypass successful-write throttle");
    clock.advance(D1_QUOTA_FLUSH_INTERVAL_MS - D1_QUOTA_ATTEMPT_INTERVAL_MS);
    maybeFlushD1Quota(env, ctx);
    await scheduled[2];
    assert.equal(kv.puts.length, 2);
});

test("single-isolate force calls cannot exceed 288 successful writes in one UTC day", async () => {
    const clock = makeClock(Date.UTC(2026, 9, 4));
    resetD1QuotaStateForTests(clock);
    const kv = makeKv();
    kv.get = async () => null; // Even a permanently stale miss cannot reset throttle.
    for (let seconds = 0; seconds < 24 * 60 * 60; seconds += 30) {
        recordD1Quota({ rows_read: 1, rows_written: 1 });
        await flushD1Quota({ KV: kv }, { force: true });
        clock.advance(30_000);
    }
    assert.equal(kv.puts.length, 288);
    const last = JSON.parse(kv.puts.at(-1).value);
    assert.equal(last.flush_count, 288);
    assert.equal(last.rows_read, 2_871);
    assert.deepEqual(peekD1QuotaPendingForTests("2026-10-04"), { rows_read: 9, rows_written: 9 });
});

test("view started before a commit reconciles stale KV with the successful local write", async () => {
    resetD1QuotaStateForTests(makeClock(Date.UTC(2026, 9, 4, 12)));
    const kv = makeKv();
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    let gets = 0;
    kv.get = async () => { if (++gets === 1) await blocked; return null; };
    recordD1Quota({ rows_read: 12, rows_written: 2 });
    const env = { KV: kv };
    const view = viewD1Quota(env);
    await flushD1Quota(env);
    recordD1Quota({ rows_read: 3, rows_written: 1 });
    release();
    const result = await view;
    assert.equal(result.rows_read, 15);
    assert.equal(result.rows_written, 3);
    assert.deepEqual(result.pending_unflushed, { rows_read: 3, rows_written: 1 });
    assert.equal(kv.puts.length, 1);
});

test("a newer snapshot observed during put is not discarded on completion", async () => {
    const t0 = Date.UTC(2026, 9, 4, 12);
    const clock = makeClock(t0);
    resetD1QuotaStateForTests(clock);
    const kv = makeKv();
    let release, entered;
    const blocked = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    const put = kv.put;
    kv.put = async function (...args) { entered(); await blocked; return put.apply(this, args); };
    recordD1Quota({ rows_read: 10, rows_written: 1 });
    const env = { KV: kv };
    const flush = flushD1Quota(env);
    await started;
    kv.store.set(d1QuotaKvKey("2026-10-04"), JSON.stringify(snapshot(t0, { rows_read: 100, rows_written: 5 })));
    await viewD1Quota(env);
    release();
    assert.equal((await flush).rows_read, 100);
    assert.equal((await viewD1Quota(env)).rows_written, 5);
    clock.advance(D1_QUOTA_FLUSH_INTERVAL_MS);
    recordD1Quota({ rows_read: 1, rows_written: 1 });
    assert.equal((await flushD1Quota(env)).rows_read, 101);
    assert.equal(JSON.parse(kv.puts.at(-1).value).rows_written, 6);
});

test("multi-day backlog survives KV failure and drains sequentially without extra writes", async () => {
    const clock = makeClock(Date.UTC(2026, 9, 2, 12));
    resetD1QuotaStateForTests(clock);
    const kv = makeKv();
    const env = { KV: kv };
    for (let day = 2; day <= 4; day++) {
        recordD1Quota({ rows_read: day, rows_written: day });
        if (day < 4) clock.advance(24 * 60 * 60 * 1_000);
    }
    const put = kv.put;
    const cause = { code: "KV_UNAVAILABLE" }; // Non-Error causes also survive intact.
    kv.put = async () => { throw cause; };
    await assert.rejects(flushD1Quota(env), (error) => assertTelemetryError(error, "put", cause, "2026-10-02"));
    for (let day = 2; day <= 4; day++) {
        assert.equal(peekD1QuotaPendingForTests(`2026-10-0${day}`).rows_read, day);
    }
    assert.equal(kv.puts.length, 0);
    kv.put = put;
    for (let day = 2; day <= 4; day++) {
        const result = await flushD1Quota(env, { force: true });
        assert.equal(result.utc_date, "2026-10-04");
        assert.equal(kv.puts.length, day - 1);
        assert.equal(kv.puts.at(-1).key, d1QuotaKvKey(`2026-10-0${day}`));
        assert.equal(JSON.parse(kv.puts.at(-1).value).rows_read, day);
        await flushD1Quota(env, { force: true });
        assert.equal(kv.puts.length, day - 1);
        clock.advance(D1_QUOTA_FLUSH_INTERVAL_MS);
    }
    await flushD1Quota(env, { force: true });
    assert.equal(kv.puts.length, 3, "empty flush performs no writes");
    assert.equal((await viewD1Quota(env)).rows_read, 4);
});

test("reset clears local successful-write throttle and lastKnown snapshots", async () => {
    const clock = makeClock(Date.UTC(2026, 9, 4, 12));
    resetD1QuotaStateForTests(clock);
    const kv = makeKv();
    kv.get = async () => null;
    recordD1Quota({ rows_read: 100, rows_written: 3 });
    await flushD1Quota({ KV: kv });
    resetD1QuotaStateForTests(clock);
    recordD1Quota({ rows_read: 1, rows_written: 0 });
    const result = await flushD1Quota({ KV: kv });
    assert.equal(kv.puts.length, 2);
    assert.equal(result.rows_read, 1);
    assert.equal(result.flush_count, 1);
});

test("missing KV keeps dated pending and reports unavailable aggregation", async () => {
    const clock = makeClock(Date.UTC(2026, 9, 4, 23, 59, 59));
    resetD1QuotaStateForTests(clock);
    recordD1Quota({ rows_read: 50, rows_written: 2 });
    clock.advance(1_000);
    recordD1Quota({ rows_read: 7, rows_written: 1 });
    assert.equal(await flushD1Quota({}, { force: true }), null);
    maybeFlushD1Quota({}, { waitUntil: () => assert.fail("no KV") });
    assert.deepEqual(await viewD1Quota({}), {
        shard_id: "primary", utc_date: "2026-10-05",
        rows_read: 7, rows_written: 1,
        rows_read_limit: 5_000_000, rows_written_limit: 100_000,
        rows_read_pct: 0, rows_written_pct: 0,
        pending_unflushed: { rows_read: 7, rows_written: 1 },
        flushed_at: null, flush_count: 0,
        aggregation_mode: "unavailable",
        confidence: "partial",
        accounting_issues: ["UNAVAILABLE"],
    });
    assert.deepEqual(peekD1QuotaPendingForTests("2026-10-04"), { rows_read: 50, rows_written: 2 });
});


test("D0 quota publication replaces 120 seconds with a five minute budget", () => {
    assert.equal(D1_QUOTA_FLUSH_INTERVAL_MS, 300_000);
});

test("expired coordinator backlog reports loss once then permits current-day flush", async () => {
    const clock = makeClock(Date.UTC(2026, 9, 1, 12));
    resetD1QuotaStateForTests(clock);
    recordD1Quota({ rows_read: 100, rows_written: 2 });
    clock.advance(4 * 86400000);
    recordD1Quota({ rows_read: 3, rows_written: 1 });
    const requests = [];
    const coordinator = { getByName() { return { async fetch(url, init) {
        if (!init) return Response.json({ snapshot: snapshot(clock.now(), { rows_read: 3, rows_written: 1 }) });
        const body = JSON.parse(init.body); requests.push(body);
        if (body.utc_date === "2026-10-01") return Response.json({ error_code: "QUOTA_DELTA_EXPIRED" }, { status: 410 });
        return Response.json({ snapshot: snapshot(clock.now(), { rows_read: body.rows_read, rows_written: body.rows_written }) });
    } }; } };
    const env = { D1_QUOTA_COORDINATOR: coordinator };
    await assert.rejects(flushD1Quota(env), error => error instanceof QuotaTelemetryError);
    const current = await flushD1Quota(env);
    assert.equal(current.rows_read, 3);
    assert.deepEqual(requests.map(body => body.utc_date), ["2026-10-01", "2026-10-05"]);
    const view = await viewD1Quota(env);
    assert.equal(view.confidence, "partial");
    assert.ok(view.accounting_issues.includes("EXPIRED_DELTA"));
});

test("unknown and malformed D1 meta remain visible as incomplete accounting", async () => {
    resetD1QuotaStateForTests(makeClock(Date.UTC(2026, 9, 4, 12)));
    const db = wrapD1({ prepare: () => makeStmt({ meta: { rows_read: Number.MAX_SAFE_INTEGER + 1, rows_written: -1 } }) });
    await db.prepare("SQL").run();
    const view = await viewD1Quota({ KV: makeKv() });
    assert.equal(view.confidence, "partial");
    assert.ok(view.accounting_issues.includes("INVALID_META"));
    assert.deepEqual(view.pending_unflushed, { rows_read: 0, rows_written: 0 });
});

test("missing KV snapshot is distinguishable from observed zero", async () => {
    resetD1QuotaStateForTests(makeClock(Date.UTC(2026, 9, 4, 12)));
    const view = await viewD1Quota({ KV: makeKv() });
    assert.equal(view.confidence, "partial");
    assert.ok(view.accounting_issues.includes("MISSING_SNAPSHOT"));
});

test("generic HTTP 410 does not discard a batch without the expiry error code", async () => {
    resetD1QuotaStateForTests(makeClock(Date.UTC(2026, 9, 4, 12)));
    recordD1Quota({ rows_read: 8, rows_written: 2 });
    const env = { D1_QUOTA_COORDINATOR: { getByName() { return { async fetch() {
        return Response.json({ error_code: "ENDPOINT_RETIRED" }, { status: 410 });
    } }; } } };
    await assert.rejects(flushD1Quota(env), error => error instanceof QuotaTelemetryError && error.status === undefined);
    assert.deepEqual(peekD1QuotaPendingForTests(), { rows_read: 8, rows_written: 2 });
});

test("invalid coordinator acknowledgement retains the same batch for retry", async () => {
    const now = Date.UTC(2026, 9, 4, 12);
    resetD1QuotaStateForTests(makeClock(now));
    recordD1Quota({ rows_read: 8, rows_written: 2 });
    const ids = [];
    const env = { D1_QUOTA_COORDINATOR: { getByName() { return { async fetch(url, init) {
        ids.push(JSON.parse(init.body).delta_id);
        const rows_read = ids.length === 1 ? Number.MAX_SAFE_INTEGER + 1 : 8;
        return Response.json({ snapshot: snapshot(now, { rows_read }) });
    } }; } } };
    await assert.rejects(flushD1Quota(env), error => error instanceof QuotaTelemetryError);
    assert.deepEqual(peekD1QuotaPendingForTests(), { rows_read: 8, rows_written: 2 });
    assert.equal((await flushD1Quota(env)).rows_read, 8);
    assert.equal(ids[0], ids[1]);
});

test("counter addition refuses overflow without partially changing either field", () => {
    const target = { rows_read: 1, rows_written: Number.MAX_SAFE_INTEGER };
    assert.throws(() => addQuotaDelta(target, { rows_read: 1, rows_written: 1 }), RangeError);
    assert.deepEqual(target, { rows_read: 1, rows_written: Number.MAX_SAFE_INTEGER });
});
