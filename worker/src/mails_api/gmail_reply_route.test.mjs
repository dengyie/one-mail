import assert from "node:assert/strict";
import test from "node:test";
import {
  completeSendMailIdempotency,
  lookupSendMailIdempotency,
  releaseSendMailIdempotency,
  reserveSendMailIdempotency,
} from "./send_mail_limit_utils.ts";

const rows = new Map();

const db = {
  prepare(sql) {
    const text = sql.replace(/\s+/g, " ");
    return {
      bind(...params) {
        return {
          async first() {
            if (text.includes("FROM gmail_reroute_idempotency")) {
              return rows.get(params[0]) ?? null;
            }
            return null;
          },
          async run() {
            if (text.startsWith("CREATE TABLE")) return { success: true };
            if (text.startsWith("INSERT INTO gmail_reroute_idempotency")) {
              const [key, requestHash] = params;
              if (rows.has(key)) {
                throw new Error("UNIQUE constraint failed: gmail_reroute_idempotency.idempotency_key");
              }
              rows.set(key, { request_hash: requestHash, job_id: "" });
              return { success: true };
            }
            if (text.startsWith("UPDATE gmail_reroute_idempotency")) {
              const [jobId, key] = params;
              const row = rows.get(key);
              if (row && !row.job_id) row.job_id = jobId;
              return { success: true };
            }
            if (text.startsWith("DELETE FROM gmail_reroute_idempotency")) {
              const key = params[0];
              const row = rows.get(key);
              if (row && !row.job_id) rows.delete(key);
              return { success: true };
            }
            return { success: true };
          },
        };
      },
      async run() {
        return { success: true };
      },
    };
  },
};

const reset = () => rows.clear();

test("a key is held before its job exists, so a different body conflicts first", async () => {
  reset();
  const taken = await reserveSendMailIdempotency(db, "key-1", "hash-1");
  assert.deepEqual(taken, { status: "reserved", owned: true });
  // The reservation is visible while the job has not been written yet.
  assert.equal((await lookupSendMailIdempotency(db, "key-1")).job_id, "");

  const conflict = await reserveSendMailIdempotency(db, "key-1", "hash-2");
  assert.equal(conflict.status, "conflict");
  assert.equal(rows.get("key-1").request_hash, "hash-1");
});

test("completing a reservation makes the next call replay the same job", async () => {
  reset();
  await reserveSendMailIdempotency(db, "key-2", "hash-1");
  await completeSendMailIdempotency(db, "key-2", "job-1");

  const replay = await reserveSendMailIdempotency(db, "key-2", "hash-1");
  assert.deepEqual(replay, { status: "replay", jobId: "job-1" });
  const conflict = await reserveSendMailIdempotency(db, "key-2", "hash-2");
  assert.equal(conflict.status, "conflict");
});

test("a concurrent identical request does not own the key it did not take", async () => {
  reset();
  await reserveSendMailIdempotency(db, "key-3", "hash-1");
  const concurrent = await reserveSendMailIdempotency(db, "key-3", "hash-1");
  // Same key and same body, job not written yet: the caller must treat this as
  // "keep going, but do not release the key" — ownership is reported, not
  // enforced, because an unfilled reservation is indistinguishable from this
  // one at the row level.
  assert.deepEqual(concurrent, { status: "reserved", owned: false });
});

test("releasing an unfulfilled reservation lets the caller retry the key", async () => {
  reset();
  await reserveSendMailIdempotency(db, "key-4", "hash-1");
  await releaseSendMailIdempotency(db, "key-4");
  assert.equal(rows.has("key-4"), false);

  const retried = await reserveSendMailIdempotency(db, "key-4", "hash-1");
  assert.deepEqual(retried, { status: "reserved", owned: true });
});

test("a completed reservation is never released", async () => {
  reset();
  await reserveSendMailIdempotency(db, "key-5", "hash-1");
  await completeSendMailIdempotency(db, "key-5", "job-5");
  await releaseSendMailIdempotency(db, "key-5");
  assert.equal((await lookupSendMailIdempotency(db, "key-5")).job_id, "job-5");
});
