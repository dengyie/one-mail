import assert from "node:assert/strict";
import test from "node:test";
import { recordD1Quota, resetD1QuotaStateForTests } from "./d1_quota.ts";
import { D1_ROWS_READ_HOURLY_LIMIT } from "./d1_quota_limits.ts";
import {
    D1HourlyReadBudgetError,
    acquireHourlyReadAllowance,
    peekHourlyGateState,
} from "./d1_quota_hourly_gate.ts";
import { D1QuotaCoordinatorDurableObject } from "./d1_quota_coordinator_do.ts";

const HOUR_MS = 3_600_000;
const HOUR0 = Date.parse("2026-11-19T08:00:00.000Z");

// Shared mutable clock: the worker-side reset and the DO harness must agree on
// "now" or the DO correctly rejects reservations for a non-current hour.
const clockRef = { value: HOUR0 + 1_000 };
const fakeClock = () => ({ now: () => clockRef.value });

const coordinatorStub = (env = {}) => {
    // Minimal DO harness: one D1QuotaCoordinatorDurableObject per test, storage
    // backed by a Map, driven through the same fetch() contract as production.
    const storage = {
        map: new Map(),
        async get(k) { return this.map.get(k); },
        async put(k, v) { this.map.set(k, v); },
        async delete(keys) { for (const k of keys) this.map.delete(k); },
        async list({ prefix = "", limit = Infinity } = {}) {
            const found = new Map();
            for (const [k, v] of this.map) if (k.startsWith(prefix) && found.size < limit) found.set(k, v);
            return found;
        },
        async transaction(fn) {
            const txn = { get: (k) => this.get(k), put: (k, v) => this.put(k, v) };
            return fn(txn);
        },
        async getAlarm() { return null; },
        async setAlarm() {},
    };
    return new D1QuotaCoordinatorDurableObject({ storage }, {}, { now: () => clockRef.value });
};

const envWithCoordinator = (env = {}) => ({ D1_QUOTA_COORDINATOR: { getByName: () => env.stub } });

const reserveViaDo = async (stub, body) => {
    const response = await stub.fetch(new Request("https://quota-coordinator/quota/delta?shard_id=primary", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    }));
    return { status: response.status, payload: await response.json() };
};

const drainHour = async (stub, hourKey, now) => {
    for (let i = 0; i < 20; i++) {
        const { payload } = await reserveViaDo(stub, {
            action: "reserve", shard_id: "primary", hour_key: hourKey, rows_read: 200_000, now,
        });
        if (payload.remaining === 0) break;
    }
};

test("gate allows queries within the reservation and records usage", async () => {
    clockRef.value = HOUR0 + 1_000;
    resetD1QuotaStateForTests(fakeClock());
    const env = envWithCoordinator({ stub: coordinatorStub() });
    await acquireHourlyReadAllowance(env);
    recordD1Quota({ rows_read: 101, rows_written: 0 });
    const gate = peekHourlyGateState();
    assert.equal(gate.hourKey, "2026-11-19T08");
    assert.ok(gate.used >= 101);
    assert.ok(gate.reserved > 0);
    assert.equal(gate.exhausted, false);
});

test("gate fails closed once the coordinator reports the hour spent", async () => {
    clockRef.value = HOUR0 + 1_000;
    resetD1QuotaStateForTests(fakeClock());
    const stub = coordinatorStub();
    // Deterministic drain: reserve directly against the coordinator until the
    // hour's allowance is spent.
    await drainHour(stub, "2026-11-19T08", clockRef.value);
    resetD1QuotaStateForTests(fakeClock());
    await assert.rejects(
        () => acquireHourlyReadAllowance(envWithCoordinator({ stub })),
        (error) => {
            assert.ok(error instanceof D1HourlyReadBudgetError);
            assert.equal(error.code, "D1_HOURLY_READ_BUDGET");
            assert.equal(error.hourKey, "2026-11-19T08");
            assert.equal(error.retryAt, "2026-11-19T09:00:00.000Z");
            return true;
        },
    );
});

test("hour rollover restores the allowance without stale exhaustion", async () => {
    clockRef.value = HOUR0 + 1_000;
    resetD1QuotaStateForTests(fakeClock());
    const stub = coordinatorStub();
    await drainHour(stub, "2026-11-19T08", clockRef.value);
    resetD1QuotaStateForTests(fakeClock());
    await assert.rejects(() => acquireHourlyReadAllowance(envWithCoordinator({ stub })), D1HourlyReadBudgetError);
    // Next hour: fresh bucket, coordinator grants a new reservation.
    clockRef.value = HOUR0 + HOUR_MS + 1_000;
    resetD1QuotaStateForTests(fakeClock());
    await acquireHourlyReadAllowance(envWithCoordinator({ stub }));
    const gate = peekHourlyGateState();
    assert.equal(gate.hourKey, "2026-11-19T09");
    assert.equal(gate.exhausted, false);
    assert.ok(gate.reserved > 0);
});

test("coordinator outage fails open briefly and still caps on local usage", async () => {
    clockRef.value = HOUR0 + 1_000;
    resetD1QuotaStateForTests(fakeClock());
    const broken = { fetch: async () => { throw new Error("DO unreachable"); } };
    const env = envWithCoordinator({ stub: broken });
    // First call fails open, flags the issue, and starts the outage window.
    await acquireHourlyReadAllowance(env);
    // Within the outage window the isolate-local cap applies.
    recordD1Quota({ rows_read: D1_ROWS_READ_HOURLY_LIMIT + 1, rows_written: 0 });
    await assert.rejects(
        () => acquireHourlyReadAllowance(envWithCoordinator({ stub: broken })),
        D1HourlyReadBudgetError,
    );
});

test("without a coordinator binding the isolate-local cap enforces the budget", async () => {
    clockRef.value = HOUR0 + 1_000;
    resetD1QuotaStateForTests(fakeClock());
    const env = {}; // no D1_QUOTA_COORDINATOR at all
    recordD1Quota({ rows_read: D1_ROWS_READ_HOURLY_LIMIT + 5, rows_written: 0 });
    await assert.rejects(() => acquireHourlyReadAllowance(env), D1HourlyReadBudgetError);
});

test("reserve rejects malformed requests and foreign hours", async () => {
    clockRef.value = HOUR0 + 1_000;
    resetD1QuotaStateForTests(fakeClock());
    const stub = coordinatorStub();
    const call = async (body) => reserveViaDo(stub, body);
    const bad = await call({ action: "reserve", shard_id: "primary", hour_key: "2026-11-19T07", rows_read: 100, now: clockRef.value });
    assert.equal(bad.status, 400);
    const bad2 = await call({ action: "reserve", shard_id: "primary", hour_key: "2026-11-19T08", rows_read: 0, now: clockRef.value });
    assert.equal(bad2.status, 400);
    const good = await call({ action: "reserve", shard_id: "primary", hour_key: "2026-11-19T08", rows_read: 500, now: clockRef.value });
    assert.equal(good.status, 200);
    assert.equal(good.payload.granted, 500);
    assert.equal(good.payload.remaining, D1_ROWS_READ_HOURLY_LIMIT - 500);
});

test("negative reserve releases unused slop and never goes below zero", async () => {
    clockRef.value = HOUR0 + 1_000;
    resetD1QuotaStateForTests(fakeClock());
    const stub = coordinatorStub();
    const call = async (rows) => reserveViaDo(stub, {
        action: "reserve", shard_id: "primary", hour_key: "2026-11-19T08", rows_read: rows, now: clockRef.value,
    });
    const grant = await call(3_000);
    assert.equal(grant.payload.granted, 3_000);
    // Release more than the ledger holds: clamped, remaining stays at the cap.
    const over = await call(-10_000);
    assert.equal(over.status, 200);
    assert.equal(over.payload.granted, -3_000);
    assert.equal(over.payload.remaining, D1_ROWS_READ_HOURLY_LIMIT);
    // Release against a partially drained ledger releases only what is held.
    await call(5_000);
    const partial = await call(-2_000);
    assert.equal(partial.payload.granted, -2_000);
    assert.equal(partial.payload.remaining, D1_ROWS_READ_HOURLY_LIMIT - 3_000);
});

test("a real query releases its unused reservation slop back to the hour", async () => {
    clockRef.value = HOUR0 + 1_000;
    resetD1QuotaStateForTests(fakeClock());
    const stub = coordinatorStub();
    const db = attachD1Quota({
        DB: fakeD1(), // all() reports meta.rows_read: 150
        D1_QUOTA_COORDINATOR: { getByName: () => stub },
    });
    await db.DB.prepare("select 1").all();
    // Probe the coordinator ledger with an oversized request: granted is
    // capped by what the hour still holds. After the release the ledger is
    // 150 (the query's real usage); without the release it would still hold
    // the phantom 1,000 chunk.
    const { payload } = await reserveViaDo(stub, {
        action: "reserve", shard_id: "primary", hour_key: "2026-11-19T08",
        rows_read: D1_ROWS_READ_HOURLY_LIMIT, now: clockRef.value,
    });
    assert.equal(payload.granted, D1_ROWS_READ_HOURLY_LIMIT - 150);
});

// ---------------------------------------------------------------------------
// wrapD1 integration: the gate must intercept every execution path of the
// wrapped binding, and batch() must count each statement's meta exactly once.
// ---------------------------------------------------------------------------

import { attachD1Quota } from "./d1_quota.ts";

const fakeD1 = () => {
    let batches = 0;
    let runs = 0;
    return {
        batchesRun: () => batches,
        runsExecuted: () => runs,
        prepare: () => ({
            bind: function () { return this; },
            all: async () => ({ results: [{ id: "m-1" }], meta: { rows_read: 150, rows_written: 0 } }),
            run: async () => {
                runs += 1;
                return { results: [], meta: { rows_read: 5, rows_written: 3 } };
            },
        }),
        batch: async (statements) => {
            batches += 1;
            return statements.map(() => ({ results: [], meta: { rows_read: 10, rows_written: 0 } }));
        },
    };
};

test("wrapped all/first fail closed when the hour is spent; write statements stay exempt", async () => {
    clockRef.value = HOUR0 + 1_000;
    resetD1QuotaStateForTests(fakeClock());
    const stub = coordinatorStub();
    await drainHour(stub, "2026-11-19T08", clockRef.value);
    const db = fakeD1();
    const env = attachD1Quota({ DB: db, D1_QUOTA_COORDINATOR: { getByName: () => stub } });
    await assert.rejects(() => env.DB.prepare("select 1").all(), D1HourlyReadBudgetError);
    await assert.rejects(() => env.DB.prepare("select 1").first(), D1HourlyReadBudgetError);
    await assert.rejects(() => env.DB.batch([env.DB.prepare("a"), env.DB.prepare("b")]), D1HourlyReadBudgetError);
    // Writes are exempt from the hourly read gate (design intent #187, restored
    // after the 2026-11-19 incident): they must reach D1 even in a spent hour —
    // losing an inbound verification mail beats burning a read reservation.
    await env.DB.prepare("insert into emails (id) values (?)").bind("m-2").run();
    await env.DB.prepare("delete 1").run();
    await env.DB.batch([env.DB.prepare("insert into t values (1)"), env.DB.prepare("update t set a = 1")]);
    assert.equal(db.batchesRun(), 1);
    assert.equal(db.runsExecuted(), 2);
});

test("write accounting is unchanged: rows_read/rows_written still recorded", async () => {
    clockRef.value = HOUR0 + 1_000;
    resetD1QuotaStateForTests(fakeClock());
    const stub = coordinatorStub();
    await drainHour(stub, "2026-11-19T08", clockRef.value);
    const env = attachD1Quota({ DB: fakeD1(), D1_QUOTA_COORDINATOR: { getByName: () => stub } });
    await env.DB.prepare("insert into emails (id) values ('m-3')").run();
    // fakeD1 run() reports rows_read: 5 — the daily/hourly ledger still sees it.
    const gate = peekHourlyGateState();
    assert.equal(gate.used, 5);
});

test("batch counts each statement meta once and consumes one gate check", async () => {
    clockRef.value = HOUR0 + 1_000;
    resetD1QuotaStateForTests(fakeClock());
    const db = fakeD1();
    const env = attachD1Quota({ DB: db, D1_QUOTA_COORDINATOR: { getByName: () => coordinatorStub() } });
    const statements = [env.DB.prepare("a"), env.DB.prepare("b")];
    await env.DB.batch(statements);
    const gate = peekHourlyGateState();
    assert.equal(gate.used, 20); // 2 statements x 10 rows_read, no double counting
    assert.equal(db.batchesRun(), 1);
    // The wrapped statements handed to batch() must be unwrapped to the raw
    // prepared statements the platform expects.
    assert.equal(db.batchesRun(), 1);
});
