import assert from "node:assert/strict";
import test from "node:test";
import {
  SendMailIdempotencyConflictError,
  lookupSendMailIdempotency,
  rememberSendMailIdempotency,
} from "./send_mail_limit_utils.ts";

const idempotency = new Map();

const db = {
  prepare(sql) {
    const text = sql.replace(/\s+/g, " ");
    const statement = {
      bind(...params) {
        return {
          async first() {
            if (text.includes("FROM gmail_reroute_idempotency")) {
              return idempotency.get(params[0]) ?? null;
            }
            return null;
          },
          async run() {
            if (text.startsWith("CREATE TABLE")) return { success: true };
            if (text.includes("INSERT INTO gmail_reroute_idempotency")) {
              if (idempotency.has(params[0])) {
                throw new Error("UNIQUE constraint failed: gmail_reroute_idempotency.idempotency_key");
              }
              idempotency.set(params[0], { request_hash: params[1], job_id: params[2] });
            }
            return { success: true };
          },
        };
      },
      async run() {
        return { success: true };
      },
    };
    return statement;
  },
};

test("the same idempotency key returns one job and a different body conflicts", async () => {
  await rememberSendMailIdempotency(db, "key-1", "hash-1", "job-1");
  const replay = await lookupSendMailIdempotency(db, "key-1");
  assert.equal(replay.job_id, "job-1");
  assert.equal(replay.request_hash, "hash-1");
  const again = await lookupSendMailIdempotency(db, "key-1");
  assert.equal(again.job_id, replay.job_id);
  const conflict = again.request_hash === "hash-2" ? null : new SendMailIdempotencyConflictError();
  assert.ok(conflict instanceof SendMailIdempotencyConflictError);
  await assert.rejects(
    () => rememberSendMailIdempotency(db, "key-1", "hash-2", "job-2"),
    /UNIQUE/,
  );
});
