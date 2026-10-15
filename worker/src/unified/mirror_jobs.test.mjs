import assert from "node:assert/strict";
import test from "node:test";
import { enqueueUnifiedMirror, processUnifiedMirrorJobs } from "./mirror_jobs.ts";

test("mirror retry queue uses a durable raw-mail identity and clears the pending marker", async () => {
  const calls = [];
  const env = {
    DB: {
      batch: async statements => statements.map(() => ({ meta: { changes: 1 } })),
      prepare(sql) {
        const statement = {
          sql,
          run: async () => ({ meta: { changes: 1 } }),
          bind(...params) {
            calls.push({ sql, params });
            return { run: async () => ({ success: true, meta: { changes: 1 } }) };
          },
        };
        return statement;
      },
    },
  };
  await enqueueUnifiedMirror(env, 42, "native-stable-42", new Error("temporary"));
  assert.match(calls[0].sql, /INSERT INTO unified_mirror_jobs/);
  assert.equal(calls[0].params[0], "native-stable-42");
  assert.equal(calls[0].params[1], 42);
  assert.equal(calls[0].params[3], "Error");
  assert.match(calls[1].sql, /UPDATE raw_mails SET mirror_pending = 0/);
});

test("mirror retry queue removes jobs whose raw mail was deleted", async () => {
  const calls = [];
  const env = {
    DB: {
      batch: async statements => statements.map(() => ({ meta: { changes: 1 } })),
      prepare(sql) {
        const statement = {
          sql,
          run: async () => ({ meta: { changes: 1 } }),
          bind(...params) {
            calls.push({ sql, params });
            return {
              sql,
              run: async () => ({ meta: { changes: 1 } }),
              all: async () => /SELECT j\.raw_mail_id/.test(sql)
                ? { results: [{ raw_mail_id: 42, job_unified_id: "native-stable-42", attempts: 0, id: null }] }
                : { results: [] },
            };
          },
        };
        return statement;
      },
    },
  };
  const result = await processUnifiedMirrorJobs(env);
  assert.deepEqual(result, { succeeded: 0, retried: 0, dropped: 1 });
  assert.ok(calls.some(call => /LEFT JOIN raw_mails/.test(call.sql)));
  assert.ok(calls.some(call => /DELETE FROM unified_mirror_jobs WHERE unified_id/.test(call.sql)));
});

test("mirror retry queue leases a failing job and schedules bounded backoff", async () => {
  const calls = [];
  const env = {
    DB: {
      prepare(sql) {
        const statement = {
          run: async () => ({ meta: { changes: 1 } }),
          bind(...params) {
            calls.push({ sql, params });
            return {
              sql,
              run: async () => ({ meta: { changes: 1 } }),
              all: async () => /SELECT j\.raw_mail_id/.test(sql)
                ? { results: [{ raw_mail_id: 43, job_unified_id: "native-stable-43", unified_id: "native-stable-43", attempts: 2, id: 43, raw: "" }] }
                : { results: [] },
            };
          },
        };
        return statement;
      },
    },
  };
  const result = await processUnifiedMirrorJobs(env);
  assert.deepEqual(result, { succeeded: 0, retried: 1, dropped: 0 });
  const lease = calls.find(call => /SET next_attempt_at = \?, updated_at = \?/.test(call.sql));
  const retry = calls.find(call => /SET attempts = \?, next_attempt_at = \?/.test(call.sql));
  assert.ok(lease);
  assert.ok(retry);
  assert.equal(retry.params[0], 3);
  assert.equal(retry.params[2], "Error");
  assert.equal(retry.params.at(-2), "native-stable-43");
});

test("mirror reconciliation queues only marked native rows and clears the marker atomically", async () => {
  const calls = [];
  const batch = [];
  const env = {
    DB: {
      prepare(sql) {
        const statement = {
          sql,
          bind(...params) {
            calls.push({ sql, params });
            return {
              sql,
              all: async () => ({ results: [
                { raw_mail_id: 1, unified_id: "native-1", unified_email_id: null, queued_unified_id: null },
                { raw_mail_id: 2, unified_id: "native-2", unified_email_id: "native-2", queued_unified_id: null },
                { raw_mail_id: 3, unified_id: "native-3", unified_email_id: null, queued_unified_id: "native-3" },
              ] }),
            };
          },
        };
        return statement;
      },
      batch: async statements => {
        batch.push(...statements);
        return statements.map(() => ({ meta: { changes: 1 } }));
      },
    },
  };
  const { reconcileUnifiedMirrorJobs } = await import("./mirror_jobs.ts");
  assert.equal(await reconcileUnifiedMirrorJobs(env, 3), 1);
  const query = calls.find(call => /FROM raw_mails rm/.test(call.sql));
  assert.match(query.sql, /WHERE rm\.mirror_pending = 1/);
  assert.equal(query.params.at(-1), 3);
  assert.equal(batch.length, 2, "queue insertion and marker clearing are committed together");
  assert.match(batch[0].sql, /INSERT OR IGNORE INTO unified_mirror_jobs/);
  assert.match(batch[1].sql, /UPDATE raw_mails SET mirror_pending = 0/);
});

test("mirror reconciliation scans only pending rows in bounded pages", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE raw_mails (id INTEGER PRIMARY KEY, source TEXT, address TEXT, raw TEXT, unified_id TEXT, mirror_pending INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE emails (id TEXT PRIMARY KEY);
    CREATE TABLE unified_mirror_jobs (
      unified_id TEXT PRIMARY KEY, raw_mail_id INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO raw_mails (id, source, address, raw, unified_id, mirror_pending) VALUES
      (1, 'a', 'a@example.com', 'one', 'native-1', 1), (2, 'a', 'a@example.com', 'two', 'native-2', 1),
      (3, 'a', 'a@example.com', 'three', 'native-3', 1), (4, 'a', 'a@example.com', 'four', 'native-4', 1),
      (5, 'a', 'a@example.com', 'five', 'native-5', 1);
    INSERT INTO emails (id) VALUES ('native-1');
    INSERT INTO unified_mirror_jobs (unified_id, raw_mail_id, next_attempt_at, attempts, created_at, updated_at)
      VALUES ('native-3', 3, 0, 0, 0, 0);
  `);
  const prepare = sql => {
    const statement = { sql, params: [] };
    statement.bind = (...params) => { statement.params = params; return statement; };
    statement.run = async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...statement.params).changes) } });
    statement.all = async () => ({ results: sqlite.prepare(sql).all(...statement.params) });
    return statement;
  };
  const env = {
    DB: {
      prepare,
      batch: async statements => {
        sqlite.exec("BEGIN");
        try {
          const results = statements.map(statement => ({
            meta: { changes: Number(sqlite.prepare(statement.sql).run(...statement.params).changes) },
          }));
          sqlite.exec("COMMIT");
          return results;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      },
    },
  };
  const { reconcileUnifiedMirrorJobs } = await import("./mirror_jobs.ts");
  assert.equal(await reconcileUnifiedMirrorJobs(env, 2), 1);
  assert.equal(await reconcileUnifiedMirrorJobs(env, 2), 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM raw_mails WHERE mirror_pending = 1").get().count, 1);
  assert.equal(await reconcileUnifiedMirrorJobs(env, 2), 1);
  assert.equal(await reconcileUnifiedMirrorJobs(env, 2), 0);
  assert.deepEqual(
    sqlite.prepare("SELECT raw_mail_id FROM unified_mirror_jobs ORDER BY raw_mail_id").all().map(row => row.raw_mail_id),
    [2, 3, 4, 5],
  );
  sqlite.close();
});
