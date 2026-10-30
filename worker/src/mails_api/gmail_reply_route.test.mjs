import assert from "node:assert/strict";
import test from "node:test";
import {
  completeSendMailIdempotency,
  lookupSendMailIdempotency,
  releaseSendMailIdempotency,
  reserveSendMailIdempotency,
} from "./send_mail_limit_utils.ts";

/** One in-memory stand-in for D1, so each test gets its own database. */
function makeDb() {
  const rows = new Map();
  const ddl = [];
  return {
    rows,
    ddl,
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
          ddl.push(sql);
          return { success: true };
        },
      };
    },
  };
}

test("a key is held before its job exists, so a different body conflicts first", async () => {
  const db = makeDb();
  const taken = await reserveSendMailIdempotency(db, "key-1", "hash-1");
  assert.deepEqual(taken, { status: "reserved", owned: true });
  // The reservation is visible while the job has not been written yet.
  assert.equal((await lookupSendMailIdempotency(db, "key-1")).job_id, "");

  const conflict = await reserveSendMailIdempotency(db, "key-1", "hash-2");
  assert.equal(conflict.status, "conflict");
  assert.equal(db.rows.get("key-1").request_hash, "hash-1");
});

test("completing a reservation makes the next call replay the same job", async () => {
  const db = makeDb();
  await reserveSendMailIdempotency(db, "key-2", "hash-1");
  await completeSendMailIdempotency(db, "key-2", "job-1");

  const replay = await reserveSendMailIdempotency(db, "key-2", "hash-1");
  assert.deepEqual(replay, { status: "replay", jobId: "job-1" });
  const conflict = await reserveSendMailIdempotency(db, "key-2", "hash-2");
  assert.equal(conflict.status, "conflict");
});

test("a concurrent identical request does not own the key it did not take", async () => {
  const db = makeDb();
  await reserveSendMailIdempotency(db, "key-3", "hash-1");
  const concurrent = await reserveSendMailIdempotency(db, "key-3", "hash-1");
  // Same key and same body, job not written yet: the caller must treat this as
  // "keep going, but do not release the key" — ownership is reported, not
  // enforced, because an unfilled reservation is indistinguishable from this
  // one at the row level.
  assert.deepEqual(concurrent, { status: "reserved", owned: false });
});

test("releasing an unfulfilled reservation lets the caller retry the key", async () => {
  const db = makeDb();
  await reserveSendMailIdempotency(db, "key-4", "hash-1");
  await releaseSendMailIdempotency(db, "key-4");
  assert.equal(db.rows.has("key-4"), false);

  const retried = await reserveSendMailIdempotency(db, "key-4", "hash-1");
  assert.deepEqual(retried, { status: "reserved", owned: true });
});

test("a completed reservation is never released", async () => {
  const db = makeDb();
  await reserveSendMailIdempotency(db, "key-5", "hash-1");
  await completeSendMailIdempotency(db, "key-5", "job-5");
  await releaseSendMailIdempotency(db, "key-5");
  assert.equal((await lookupSendMailIdempotency(db, "key-5")).job_id, "job-5");
});

test("the schema DDL is issued once per database, not once per send", async () => {
  const db = makeDb();
  await reserveSendMailIdempotency(db, "key-6", "hash-1");
  await reserveSendMailIdempotency(db, "key-7", "hash-1");
  await lookupSendMailIdempotency(db, "key-6");
  await releaseSendMailIdempotency(db, "key-7");

  assert.equal(db.ddl.length, 1, "every call after the first must reuse the memoized schema promise");
  assert.match(db.ddl[0], /CREATE TABLE IF NOT EXISTS gmail_reroute_idempotency/);
});

test("a failed schema ensure is retried instead of being remembered as ready", async () => {
  const db = makeDb();
  let fail = true;
  const flaky = {
    rows: db.rows,
    prepare(sql) {
      if (/\bCREATE TABLE\b/.test(sql) && fail) {
        return { async run() { throw new Error("D1 unavailable"); } };
      }
      return db.prepare(sql);
    },
  };

  await assert.rejects(() => reserveSendMailIdempotency(flaky, "key-8", "hash-1"), /D1 unavailable/);
  fail = false;
  const retried = await reserveSendMailIdempotency(flaky, "key-8", "hash-1");
  assert.deepEqual(retried, { status: "reserved", owned: true });
});
