import assert from "node:assert/strict";
import test from "node:test";
import { pruneTerminalJobs } from "./job_pruning.ts";

function fakeDb({ changes = 0 } = {}) {
    const calls = [];
    return {
        calls,
        prepare(sql) {
            return {
                bind(...params) {
                    calls.push({ sql, params });
                    return { run: async () => ({ meta: { changes } }) };
                },
            };
        },
    };
}

const day = 24 * 60 * 60 * 1000;

test("prunes both job tables with a cutoff derived from the retention window", async () => {
    const before = Date.now();
    const db = fakeDb({ changes: 7 });
    const result = await pruneTerminalJobs({ DB: db }, 30, 500);
    assert.deepEqual(result, { mutation: 7, outbound: 7 });

    assert.equal(db.calls.length, 2);
    for (const call of db.calls) {
        assert.match(call.sql, /COALESCE\(completed_at, updated_at\) < \?/);
        assert.equal(call.params[1], 500, "batch limit must be passed as a bound parameter");
        const cutoff = call.params[0];
        assert.ok(cutoff <= before - 30 * day && cutoff > before - 31 * day);
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

test("deletes are bounded by a rowid subquery so one cron tick cannot sweep the table", async () => {
    const db = fakeDb();
    await pruneTerminalJobs({ DB: db }, 30, 500);
    for (const call of db.calls) {
        assert.match(call.sql, /WHERE rowid IN \(\s*SELECT rowid FROM/);
        assert.match(call.sql, /LIMIT \?/);
    }
});

test("out-of-range arguments fall back to the documented defaults", async () => {
    const db = fakeDb();
    await pruneTerminalJobs({ DB: db }, 0, 0);
    assert.equal(db.calls[0].params[1], 500, "invalid batch limit falls back to the default");

    const db2 = fakeDb();
    await pruneTerminalJobs({ DB: db2 }, -5, 999999);
    const cutoff = db2.calls[0].params[0];
    assert.ok(cutoff <= Date.now() - 30 * day && cutoff > Date.now() - 31 * day);
    assert.equal(db2.calls[0].params[1], 5000, "batch limit is clamped, not trusted");
});