import assert from "node:assert/strict";
import test from "node:test";
import { toEmailInsertParams } from "./ingest.ts";

test("toEmailInsertParams fills defaults and keeps legacy imap_uid as source_key", () => {
  const p = toEmailInsertParams({
    source: "imap_qq", account_id: "qq", from_addr: "a@b.com", to_addr: "me@qq.com",
    subject: "s", imap_uid: "h:INBOX:1:5",
  }, "uuid-1", 1700000000000);
  assert.equal(p[0], "uuid-1");           // id
  assert.equal(p[1], "imap_qq");          // source
  assert.equal(p[8], 1700000000000);      // received_at default = now
  assert.equal(p[11], 0);                 // is_read default
  assert.equal(p[15], "h:INBOX:1:5");     // legacy imap_uid
  assert.equal(p[26], "h:INBOX:1:5");     // rolling-deploy source_key fallback
  assert.equal(p.length, 28);
});

test("toEmailInsertParams persists provider identity without promoting unknown fields", () => {
  const p = toEmailInsertParams({
    source: "graph_outlook",
    account_id: "acc-1",
    from_addr: "a@b.com",
    to_addr: "me@outlook.com",
    provider: "graph",
    source_folder: "INBOX",
    source_folder_id: "folder-immutable",
    provider_message_id: "msg-immutable",
    provider_thread_id: "conv-1",
    message_id_header: "<rfc@example.com>",
    in_reply_to: "<parent@example.com>",
    references_json: ["<root@example.com>", "<parent@example.com>"],
    attachments_json: [{ name: "x.txt" }],
    source_key: "graph:acc-1:msg-immutable",
    sync_version: 1,
  }, "uuid-2", 2);

  assert.equal(p[17], "graph");
  assert.equal(p[18], "INBOX");
  assert.equal(p[19], "folder-immutable");
  assert.equal(p[20], "msg-immutable");
  assert.equal(p[21], "conv-1");
  assert.equal(p[22], "<rfc@example.com>");
  assert.equal(p[23], "<parent@example.com>");
  assert.equal(p[24], JSON.stringify(["<root@example.com>", "<parent@example.com>"]));
  assert.equal(p[25], 1);
  assert.equal(p[26], "graph:acc-1:msg-immutable");
  assert.equal(p[27], 1);
});

test("provider_message_id without provider fails closed", () => {
  assert.throws(() => toEmailInsertParams({
    source: "graph_outlook", account_id: "a", from_addr: "x@y", to_addr: "m@n",
    provider_message_id: "stable-but-unscoped",
  }, "id", 1), /provider required/);
});

test("toEmailInsertParams throws when from/to missing", () => {
  assert.throws(() => toEmailInsertParams({ source: "imap_qq" }, "id", 1));
});

test("C1: toEmailInsertParams rejects missing account_id (fail-closed)", () => {
  assert.throws(
    () => toEmailInsertParams({ source: "imap_qq", from_addr: "a@b.com", to_addr: "me@qq.com" }, "id", 1),
    /account_id required/,
  );
  const ok = toEmailInsertParams({
    source: "imap_qq", account_id: "qq", from_addr: "a@b.com", to_addr: "me@qq.com",
  }, "id", 1);
  assert.equal(ok[2], "qq");
});

test("insertEmails prepares batch statements using INSERT_EMAIL_SQL", async () => {
  const { insertEmails } = await import("./ingest.ts");
  const calls = [];
  const fakeEnv = {
    DB: {
      prepare(sql) {
        calls.push(sql);
        return {
          bind(...params) {
            return { sql, params };
          },
        };
      },
      async batch(stmts) {
        return stmts.map(() => ({ meta: { changes: 1 } }));
      },
    },
  };
  const fakeContext = { env: fakeEnv };
  const res = await insertEmails(fakeContext, [
    { source: "imap_qq", account_id: "qq", from_addr: "a@b.com", to_addr: "me@qq.com" },
  ]);
  assert.equal(res.inserted, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /INSERT OR IGNORE INTO emails/);
});

test("provider identity replay refreshes folder metadata without counting a new email", async () => {
  const { insertEmails } = await import("./ingest.ts");
  const batches = [];
  const fakeEnv = {
    DB: {
      prepare(sql) {
        return {
          bind(...params) {
            return { sql, params };
          },
        };
      },
      async batch(stmts) {
        batches.push(stmts);
        return stmts.map((stmt) => ({
          meta: { changes: stmt.sql.includes("INSERT OR IGNORE INTO emails") ? 0 : 1 },
        }));
      },
    },
  };

  const res = await insertEmails({ env: fakeEnv }, [{
    source: "graph_outlook",
    account_id: "acc-1",
    from_addr: "a@b.com",
    to_addr: "me@outlook.com",
    provider: "graph",
    source_folder: "Archive",
    source_folder_id: "folder-2",
    provider_message_id: "immutable-1",
    provider_thread_id: "conv-1",
    source_key: "graph:acc-1:immutable-1",
    sync_version: 1,
  }]);

  assert.deepEqual(res, { inserted: 0, skipped: 1 });
  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 1);
  assert.match(batches[0][0].sql, /INSERT OR IGNORE INTO emails/);

  assert.equal(batches[1].length, 2);
  const refresh = batches[1].find((s) => s.sql.startsWith("UPDATE emails SET"));
  const folder = batches[1].find((s) => s.sql.includes("INSERT INTO mail_account_folders"));
  assert.ok(refresh);
  assert.ok(folder);
  assert.equal(refresh.params.at(-3), "acc-1");
  assert.equal(refresh.params.at(-2), "graph");
  assert.equal(refresh.params.at(-1), "immutable-1");
  assert.equal(folder.params[2], "folder-2");
  assert.equal(folder.params[3], "Archive");
});
