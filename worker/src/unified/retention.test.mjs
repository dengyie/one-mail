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

/**
 * The attachment reference check is one full `emails` scan per invocation, so it
 * must be issued once per drain batch rather than once per GC row — otherwise a
 * full GC batch alone burns 100 table scans of rows_read.
 */
function gcDb({ gcKeys, referencedKeys }) {
  const calls = [];
  const deletedGc = [];
  const db = {
    prepare(sql) {
      return {
        bind(...params) {
          calls.push({ sql, params });
          return {
            all: async () => {
              if (/FROM attachment_gc/.test(sql)) {
                return { results: gcKeys.map(r2_key => ({ r2_key })) };
              }
              if (/json_each/.test(sql)) {
                return { results: referencedKeys.map(r2_key => ({ r2_key })) };
              }
              return { results: [] };
            },
            first: async () => null,
            run: async () => {
              if (/DELETE FROM attachment_gc/.test(sql)) deletedGc.push(params[0]);
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
    batch: async () => [],
  };
  return { db, calls, deletedGc };
}

test("attachment GC checks email references once per batch, not once per row", async () => {
  const gcKeys = Array.from({ length: 120 }, (_, i) => `attachment-${i}`);
  const { db, calls } = gcDb({ gcKeys, referencedKeys: [] });
  const deleted = [];
  await cleanupReadEmails(
    { DB: db, ATTACHMENTS: { delete: async key => deleted.push(key) } },
    90, 1, 1,
  );
  const referenceScans = calls.filter(call => /json_each/.test(call.sql));
  assert.equal(referenceScans.length, 3, "120 keys should chunk into 50 + 50 + 20");
  // Every reference scan carries a whole chunk of keys, never a single key.
  assert.ok(referenceScans.every(call => call.params.length > 1));
  assert.equal(deleted.length, gcKeys.length);
});

test("attachment GC keeps R2 objects that a batched scan still finds referenced", async () => {
  const { db, deletedGc } = gcDb({
    gcKeys: ["a-1", "a-2", "a-3"],
    referencedKeys: ["a-2"],
  });
  const deleted = [];
  await cleanupReadEmails(
    { DB: db, ATTACHMENTS: { delete: async key => deleted.push(key) } },
    90, 1, 1,
  );
  assert.deepEqual(deleted, ["a-1", "a-3"]);
  // Every GC row is retired either way: a live object makes the request stale,
  // a deleted object has nothing left to clean up.
  assert.deepEqual(deletedGc, ["a-1", "a-2", "a-3"]);
});
