import assert from "node:assert/strict";
import test from "node:test";
import { INSERT_EMAIL_SQL, insertEmail } from "./ingest.ts";

test("INSERT_EMAIL_SQL has 17 placeholders", () => {
  const placeholders = (INSERT_EMAIL_SQL.match(/\?/g) || []).length;
  assert.equal(placeholders, 17);
});

test("insertEmail binds params in order", async () => {
  const calls = [];
  const db = { prepare: (sql) => ({ bind: (...args) => { calls.push({ sql, args }); return { run: async () => ({ success: true }) }; } }) };
  const params = Array.from({ length: 17 }, (_, i) => `p${i}`);
  await insertEmail({ env: { DB: db } }, params);
  assert.equal(calls[0].args.length, 17);
  assert.equal(calls[0].args[0], "p0");
  assert.equal(calls[0].args[16], "p16");
});
