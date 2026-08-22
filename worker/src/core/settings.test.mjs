import assert from "node:assert/strict";
import test from "node:test";
import { getSetting, saveSetting, getJsonSetting, deleteSetting } from "./settings.ts";

const makeDb = (rows = {}) => {
  const calls = [];
  const prepare = (sql) => ({
    bind: (...args) => ({
      first: async (col) => { calls.push({ sql, args }); return rows[col] ?? null; },
      run: async () => { calls.push({ sql, args }); return { success: true }; },
    }),
  });
  return { db: { prepare }, calls };
};

test("getSetting returns value row", async () => {
  const { db } = makeDb({ value: "hello" });
  assert.equal(await getSetting({ env: { DB: db } }, "user_settings"), "hello");
});

test("getSetting missing → null", async () => {
  const { db } = makeDb({});
  assert.equal(await getSetting({ env: { DB: db } }, "missing"), null);
});

test("getJsonSetting parses JSON", async () => {
  const { db } = makeDb({ value: '{"maxAddressCount":5}' });
  assert.deepEqual(await getJsonSetting({ env: { DB: db } }, "user_settings"), { maxAddressCount: 5 });
});

test("getJsonSetting bad JSON → null", async () => {
  const { db } = makeDb({ value: "{oops" });
  assert.equal(await getJsonSetting({ env: { DB: db } }, "user_settings"), null);
});

test("saveSetting runs INSERT OR REPLACE", async () => {
  const { db, calls } = makeDb();
  await saveSetting({ env: { DB: db } }, "k", "v");
  assert.ok(calls[0].sql.includes("INSERT or REPLACE INTO settings"));
});
