import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupReadEmails,
  cutoffMs,
  purgeOldEmailBodies,
} from "./retention.ts";

test("cutoffMs subtracts N days in ms", () => {
  const now = 1700000000000;
  assert.equal(cutoffMs(90, now), now - 90 * 24 * 60 * 60 * 1000);
  assert.equal(cutoffMs(30, now), now - 30 * 24 * 60 * 60 * 1000);
  assert.equal(cutoffMs(0, now), now);
});

function fakeDb({ rows = [], changes = 0 } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...params) {
          calls.push({ sql, params });
          return {
            all: async () => ({ results: rows }),
            run: async () => ({ meta: { changes } }),
          };
        },
      };
    },
  };
}

test("retention cleanup is bounded and preserves starred rows", async () => {
  const db = fakeDb({
    rows: [{ id: "mail-1", attachments_json: "[]" }],
    changes: 1,
  });
  const result = await cleanupReadEmails({ DB: db }, 90, 1, 1);
  assert.deepEqual(result, { deleted: 1, limited: true });
  assert.equal(db.calls.length, 2);
  assert.match(db.calls[0].sql, /is_starred\s+IS NULL OR is_starred = 0/);
  assert.match(db.calls[1].sql, /is_starred\s+IS NULL OR is_starred = 0/);
});

test("body purge stops after the configured batch budget", async () => {
  const db = fakeDb({ changes: 1 });
  const result = await purgeOldEmailBodies({ DB: db }, 30, 1, 2);
  assert.deepEqual(result, { purged: 2, limited: true });
  assert.equal(db.calls.length, 2);
});

test("retention keeps rows when R2 attachment cleanup fails", async () => {
  const db = fakeDb({
    rows: [{ id: "mail-1", attachments_json: JSON.stringify([{ r2_key: "attachment-1" }]) }],
    changes: 1,
  });
  const bucket = {
    delete: async () => { throw new Error("temporary R2 outage"); },
  };
  await assert.rejects(
    cleanupReadEmails({ DB: db, ATTACHMENTS: bucket }, 90, 1, 1),
    /r2 attachment cleanup failed/,
  );
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /SELECT id, attachments_json/);
});
