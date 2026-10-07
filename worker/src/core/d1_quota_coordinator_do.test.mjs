import assert from "node:assert/strict";
import test from "node:test";
import { D1QuotaCoordinatorDurableObject } from "./d1_quota_coordinator_do.ts";

const makeState = () => {
    const values = new Map();
    const alarms = [];
    const batches = [];
    const storage = {
        async getAlarm() { return alarms.at(-1) ?? null; },
        async setAlarm(time) { alarms.push(time); },
        async list(options) { return new Map([...values].filter(([key]) => key.startsWith(options.prefix) && (!options.end || key < options.end)).sort(([a], [b]) => a.localeCompare(b)).slice(0, options.limit)); },
        async delete(keys) { batches.push(keys); for (const key of keys) values.delete(key); },
        async get(key) { return values.get(key); },
        async put(key, value) { values.set(key, value); },
        async transaction(callback) {
            const txn = {
                get: async (key) => values.get(key),
                put: async (key, value) => { values.set(key, value); },
            };
            return callback(txn);
        },
    };
    return { storage, values, alarms, batches };
};

const request = (deltaId, rowsRead, now = Date.UTC(2026, 9, 5, 12)) => new Request(
    `https://quota/quota/delta?utc_date=2026-10-05`,
    {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            action: "delta", shard_id: "shard1", utc_date: "2026-10-05",
            delta_id: deltaId, rows_read: rowsRead, rows_written: 1, now,
        }),
    },
);

test("coordinator serializes concurrent deltas and deduplicates retry IDs", async () => {
    const state = makeState();
    const object = new D1QuotaCoordinatorDurableObject(state, {}, { now: () => Date.UTC(2026, 9, 5, 12) });
    const [first, second, retry] = await Promise.all([
        object.fetch(request("delta-00000001", 10)),
        object.fetch(request("delta-00000002", 20)),
        object.fetch(request("delta-00000001", 10)),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(retry.status, 200);
    const values = await Promise.all([first.json(), second.json(), retry.json()]);
    assert.equal(values[1].snapshot.rows_read, 30);
    assert.equal(values[2].duplicate, true);
    const read = await object.fetch(new Request("https://quota/quota/delta?utc_date=2026-10-05&shard_id=shard1"));
    assert.equal((await read.json()).snapshot.rows_read, 30);
});

test("snapshot publication failure leaves an idempotent committed delta for retry", async () => {
    const state = makeState();
    let puts = 0;
    const kv = {
        async put() {
            puts++;
            if (puts === 1) throw new Error("KV unavailable");
        },
    };
    let now = Date.UTC(2026, 9, 5, 12);
    const object = new D1QuotaCoordinatorDurableObject(state, { D1_QUOTA_KV: kv }, { now: () => now });
    const failed = await object.fetch(request("delta-00000003", 7));
    assert.equal(failed.status, 503);
    now += 300_000;
    const retried = await object.fetch(request("delta-00000003", 7, now));
    const body = await retried.json();
    assert.equal(retried.status, 200, JSON.stringify(body));
    assert.equal(body.duplicate, true);
    assert.equal(body.snapshot.rows_read, 7);
    assert.equal(puts, 2);
});

test("invalid and cross-shard identities fail closed", async () => {
    const state = makeState();
    const object = new D1QuotaCoordinatorDurableObject(state, {}, { now: () => Date.UTC(2026, 9, 5, 12) });
    const invalid = await object.fetch(new Request("https://quota/quota/delta?utc_date=2026-10-05", { method: "GET" }));
    assert.equal(invalid.status, 400);
    const first = await object.fetch(request("delta-00000004", 1));
    assert.equal(first.status, 200);
    const mismatch = await object.fetch(new Request("https://quota/quota/delta?utc_date=2026-10-05", {
        method: "POST",
        body: JSON.stringify({ action: "delta", shard_id: "other", utc_date: "2026-10-05", delta_id: "delta-00000005", rows_read: 1, rows_written: 0, now: Date.now() }),
    }));
    assert.equal(mismatch.status, 503);
});


test("calendar validation rejects impossible dates and future days", async () => {
    const state = makeState();
    const object = new D1QuotaCoordinatorDurableObject(state, {}, { now: () => Date.UTC(2026, 9, 5, 12) });
    for (const date of ["2026-02-30", "2026-10-06", "2026-13-01"]) {
        const body = await request("date-invalid", 1).json();
        body.utc_date = date;
        const result = await object.fetch(new Request("https://quota/", { method: "POST", body: JSON.stringify(body) }));
        assert.equal(result.status, 400, date);
    }
});

test("expired delta is rejected using server clock even when client clock lies", async () => {
    const state = makeState();
    const object = new D1QuotaCoordinatorDurableObject(state, {}, { now: () => Date.UTC(2026, 9, 9, 12) });
    const response = await object.fetch(request("expired-delta", 100));
    assert.equal(response.status, 410);
    assert.equal((await response.json()).error_code, "QUOTA_DELTA_EXPIRED");
    assert.equal([...state.values.keys()].some(key => key.startsWith("delta:")), false);
});

test("counter addition overflow leaves both state and marker untouched", async () => {
    const state = makeState();
    const object = new D1QuotaCoordinatorDurableObject(state, {}, { now: () => Date.UTC(2026, 9, 5, 12) });
    assert.equal((await object.fetch(request("counter-max", Number.MAX_SAFE_INTEGER))).status, 200);
    const result = await object.fetch(request("counter-overflow", 1));
    assert.equal(result.status, 422);
    assert.equal(state.values.get("state:2026-10-05").rows_read, Number.MAX_SAFE_INTEGER);
    assert.equal(state.values.has("delta:2026-10-05:counter-overflow"), false);
});

test("alarm deletes expired markers in bounded batches and blocks old replay", async () => {
    const state = makeState();
    let now = Date.UTC(2026, 9, 5, 12);
    const object = new D1QuotaCoordinatorDurableObject(state, {}, { now: () => now });
    for (let i = 0; i < 300; i++) state.values.set(`delta:2026-10-01:old-${i}`, true);
    await object.fetch(request("valid-marker", 1));
    assert.ok(state.alarms.length > 0);
    await object.alarm();
    assert.ok(state.batches.every(batch => batch.length <= 128));
    assert.ok([...state.values.keys()].some(key => key.startsWith("delta:2026-10-01:")));
    await object.alarm();
    await object.alarm();
    assert.equal([...state.values.keys()].some(key => key.startsWith("delta:2026-10-01:")), false);
    assert.ok(state.values.has("delta:2026-10-05:valid-marker"));
    now = Date.UTC(2026, 9, 10, 12);
    await object.alarm();
    assert.equal((await object.fetch(request("valid-marker", 1))).status, 410);
    now = Date.UTC(2026, 9, 5, 12);
    assert.equal((await object.fetch(request("valid-marker", 1))).status, 410, "clock rollback cannot reopen pruned replay window");
});

test("snapshot publication is globally throttled across UTC day buckets", async () => {
    const state = makeState();
    let now = Date.UTC(2026, 9, 5, 23, 59, 59);
    const puts = [];
    const object = new D1QuotaCoordinatorDurableObject(state, { D1_QUOTA_KV: { async put(...args) { puts.push(args); } } }, { now: () => now });
    await object.fetch(request("first-today", 1, now));
    now += 1000;
    const body = await request("new-utc-day", 2, now).json();
    body.utc_date = "2026-10-06";
    await object.fetch(new Request("https://quota/", { method: "POST", body: JSON.stringify(body) }));
    assert.equal(puts.length, 1);
    now += 299000;
    await object.fetch(new Request("https://quota/", { method: "POST", body: JSON.stringify(body) }));
    assert.equal(puts.length, 2);
});

test("unknown coordinator snapshot is explicitly missing for fleet readers", async () => {
    const state = makeState();
    const object = new D1QuotaCoordinatorDurableObject(state, {}, { now: () => Date.UTC(2026, 9, 5, 12) });
    const response = await object.fetch(new Request("https://quota/?utc_date=2026-10-05&shard_id=shard1"));
    const body = await response.json();
    assert.equal(body.available, false);
    assert.equal(body.confidence, "partial");
});

test("KV failure cannot cause retry writes inside a reserved publication interval", async () => {
    const state = makeState();
    let now = Date.UTC(2026, 9, 5, 12);
    let attempts = 0;
    const object = new D1QuotaCoordinatorDurableObject(state, { D1_QUOTA_KV: { async put() {
        if (++attempts === 1) throw new Error("publication outcome unknown");
    } } }, { now: () => now });
    assert.equal((await object.fetch(request("uncertain-publish", 8))).status, 503);
    now += 30_000;
    const retry = await object.fetch(request("uncertain-publish", 8));
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).snapshot.rows_read, 8);
    assert.equal(attempts, 1);
    now += 270_000;
    await object.fetch(request("uncertain-publish", 8));
    assert.equal(attempts, 2);
});

test("cleanup errors propagate for alarm retry without reopening replay window", async () => {
    const state = makeState();
    const cause = new Error("storage delete failed");
    state.values.set("delta:2026-10-01:expired-marker", true);
    state.storage.delete = async () => { throw cause; };
    const object = new D1QuotaCoordinatorDurableObject(state, {}, { now: () => Date.UTC(2026, 9, 5, 12) });
    await assert.rejects(object.alarm(), error => error === cause);
    assert.equal(state.values.get("meta:retention_floor"), "2026-10-03");
    const body = await request("expired-marker", 1).json();
    body.utc_date = "2026-10-01";
    const response = await object.fetch(new Request("https://quota/", { method: "POST", body: JSON.stringify(body) }));
    assert.equal(response.status, 410);
});

test("DO restart retains replay dedup and shared KV throttle", async () => {
    const state = makeState();
    const puts = [];
    const env = { D1_QUOTA_KV: { async put(...args) { puts.push(args); } } };
    const clock = { now: () => Date.UTC(2026, 9, 5, 12) };
    await new D1QuotaCoordinatorDurableObject(state, env, clock).fetch(request("restart-marker", 2));
    const restarted = new D1QuotaCoordinatorDurableObject(state, env, clock);
    const response = await restarted.fetch(request("restart-marker", 2));
    const body = await response.json();
    assert.equal(body.duplicate, true);
    assert.equal(body.snapshot.rows_read, 2);
    assert.equal(puts.length, 1);
});
