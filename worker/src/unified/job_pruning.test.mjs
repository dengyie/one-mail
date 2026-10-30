import assert from "node:assert/strict";
import test from "node:test";
import { pruneTerminalJobs } from "./job_pruning.ts";

function fakeDb({ changes = 0 } = {}) {
    const calls = [];
    const ddl = [];
    return {
        calls,
        ddl,
        prepare(sql) {
            return {
                bind(...params) {
                    calls.push({ sql, params });
                    return { run: async () => ({ meta: { changes } }) };
                },
                async run() {
                    ddl.push(sql);
                    return { meta: { changes: 0 } };
                },
            };
        },
    };
}

const day = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-10-08T12:00:00Z');

test("prunes every job table with a cutoff derived from the retention window", async t => {
    t.mock.method(Date, 'now', () => now);
    const db = fakeDb({ changes: 7 });
    const result = await pruneTerminalJobs({ DB: db }, 30, 500);
    assert.deepEqual(result, { mutation: 7, outbound: 7, idempotency: 7 });

    assert.equal(db.calls.length, 3);
    const [mutation, outbound, idempotency] = db.calls;
    for (const call of [mutation, outbound]) {
        assert.match(call.sql, /COALESCE\(completed_at, updated_at\) < \?/);
    }
    assert.match(idempotency.sql, /FROM gmail_reroute_idempotency/);
    for (const call of db.calls) {
        assert.equal(call.params[1], 500, "batch limit must be passed as a bound parameter");
        assert.equal(call.params[0], now - 30 * day);
    }
});

test("never deletes a live job: pending and processing are excluded", async () => {
    const db = fakeDb();
    await pruneTerminalJobs({ DB: db });
    const statuses = db.calls.map(call => call.sql).join("\n");
    assert.match(statuses, /'succeeded', 'failed', 'unsupported', 'superseded'/);
    assert.match(statuses, /'succeeded', 'failed', 'unsupported'/);
    for (const forbidden of ["'pending'", "'processing'"]) {
        assert.ok(!statuses.includes(forbidden), `${forbidden} must not be prunable`);
    }
});

test("only ids whose job is still missing are reclaimed; a filled id is kept forever", async () => {
    const db = fakeDb();
    await pruneTerminalJobs({ DB: db });
    const idempotency = db.calls.find(call => /FROM gmail_reroute_idempotency/.test(call.sql));
    assert.ok(idempotency, "the idempotency table must be pruned");
    assert.match(idempotency.sql, /\(job_id IS NULL OR job_id = ''\)/);
    assert.ok(
        !/job_id (?:IS NOT NULL|!= '')/.test(idempotency.sql),
        "a reservation that owns a job is what prevents a duplicate send and must survive",
    );
});

test("the idempotency schema is ensured before it is pruned", async () => {
    const db = fakeDb();
    await pruneTerminalJobs({ DB: db });
    assert.equal(db.ddl.length, 1);
    assert.match(db.ddl[0], /CREATE TABLE IF NOT EXISTS gmail_reroute_idempotency/);
});

test("deletes are bounded by a rowid subquery so one cron tick cannot sweep the table", async () => {
    const db = fakeDb();
    await pruneTerminalJobs({ DB: db }, 30, 500);
    for (const call of db.calls) {
        assert.match(call.sql, /WHERE rowid IN \(\s*SELECT rowid FROM/);
        assert.match(call.sql, /LIMIT \?/);
    }
});

test("out-of-range arguments fall back to the documented defaults", async t => {
    t.mock.method(Date, 'now', () => now);
    const db = fakeDb();
    await pruneTerminalJobs({ DB: db }, 0, 0);
    assert.equal(db.calls[0].params[1], 500, "invalid batch limit falls back to the default");

    const db2 = fakeDb();
    await pruneTerminalJobs({ DB: db2 }, -5, 999999);
    const cutoff = db2.calls[0].params[0];
    assert.equal(cutoff, now - 30 * day);
    assert.equal(db2.calls[0].params[1], 5000, "batch limit is clamped, not trusted");
});
