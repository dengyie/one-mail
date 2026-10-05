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
            first: async () => null,
            run: async () => ({ meta: { changes } }),
          };
        },
      };
    },
    batch: async statements => statements.map(statement => ({ meta: { changes } })),
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

test("retention commits DB deletion before R2 cleanup and keeps failed GC rows", async () => {
  const db = fakeDb({
    rows: [{ id: "mail-1", attachments_json: JSON.stringify([{ r2_key: "attachment-1" }]) }],
    changes: 1,
  });
  const bucket = {
    delete: async () => { throw new Error("temporary R2 outage"); },
  };
  const result = await cleanupReadEmails({ DB: db, ATTACHMENTS: bucket }, 90, 1, 1);
  assert.deepEqual(result, { deleted: 1, limited: true });
  assert.ok(db.calls.some(call => /json_each/.test(call.sql)));
  assert.ok(db.calls.some(call => /attachment_gc/.test(call.sql)));
  assert.equal(db.calls.filter(call => /DELETE FROM emails/.test(call.sql)).length, 1);
});

test("retention binds email IDs as one JSON value instead of one parameter per ID", async () => {
  const db = fakeDb({
    rows: Array.from({ length: 101 }, (_, i) => ({ id: `mail-${i}`, attachments_json: "[]" })),
    changes: 101,
  });
  await cleanupReadEmails({ DB: db }, 90, 101, 1);
  const deletion = db.calls.find(call => /DELETE FROM emails/.test(call.sql));
  assert.ok(deletion);
  assert.match(deletion.sql, /json_each\(\?\)/);
  assert.equal(deletion.params.length, 2);
  assert.equal(JSON.parse(deletion.params[1]).length, 101);
});

test("retention drains a durable GC row even when no email is newly eligible", async () => {
  const calls = [];
  let deletedGc = false;
  const db = {
    prepare(sql) {
      return {
        bind(...params) {
          calls.push({ sql, params });
          return {
            all: async () => /SELECT r2_key FROM attachment_gc/.test(sql)
              ? { results: deletedGc ? [] : [{ r2_key: "attachment-retry" }] }
              : { results: [] },
            first: async () => null,
            run: async () => {
              if (/DELETE FROM attachment_gc/.test(sql)) deletedGc = true;
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
    batch: async () => [],
  };
  const deleted = [];
  await cleanupReadEmails({ DB: db, ATTACHMENTS: { delete: async key => deleted.push(key) } }, 90, 1, 1);
  assert.deepEqual(deleted, ["attachment-retry"]);
  assert.ok(calls.some(call => /SELECT r2_key FROM attachment_gc/.test(call.sql)));
});
