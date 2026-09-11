import assert from "node:assert/strict";
import test from "node:test";
import { INSERT_EMAIL_SQL, insertEmail } from "./ingest.ts";

test("INSERT_EMAIL_SQL has 28 placeholders including provider identity tail", () => {
  const placeholders = (INSERT_EMAIL_SQL.match(/\?/g) || []).length;
  assert.equal(placeholders, 28);
  assert.match(INSERT_EMAIL_SQL, /provider,source_folder,source_folder_id,provider_message_id,provider_thread_id/);
  assert.match(INSERT_EMAIL_SQL, /message_id_header,in_reply_to,references_json,has_attachments,source_key,sync_version/);
});

test("insertEmail binds params in order", async () => {
  const calls = [];
  const db = { prepare: (sql) => ({ bind: (...args) => { calls.push({ sql, args }); return { run: async () => ({ success: true }) }; } }) };
  const params = Array.from({ length: 28 }, (_, i) => `p${i}`);
  await insertEmail({ env: { DB: db } }, params);
  assert.equal(calls[0].args.length, 28);
  assert.equal(calls[0].args[0], "p0");
  assert.equal(calls[0].args[27], "p27");
});
