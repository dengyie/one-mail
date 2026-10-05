import assert from "node:assert/strict";
import test from "node:test";
import { D1QuotaCoordinatorDurableObject } from "./d1_quota_coordinator_do.ts";

const makeState = () => {
    const values = new Map();
    const storage = {
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
    return { storage, values };
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
    const object = new D1QuotaCoordinatorDurableObject(state, {});
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
    const object = new D1QuotaCoordinatorDurableObject(state, { D1_QUOTA_KV: kv });
    const failed = await object.fetch(request("delta-00000003", 7));
    assert.equal(failed.status, 503);
    const retried = await object.fetch(request("delta-00000003", 7, Date.UTC(2026, 9, 5, 12, 1)));
    const body = await retried.json();
    assert.equal(retried.status, 200, JSON.stringify(body));
    assert.equal(body.duplicate, true);
    assert.equal(body.snapshot.rows_read, 7);
    assert.equal(puts, 2);
});

test("invalid and cross-shard identities fail closed", async () => {
    const state = makeState();
    const object = new D1QuotaCoordinatorDurableObject(state, {});
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
