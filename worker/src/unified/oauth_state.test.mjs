import assert from "node:assert/strict";
import test from "node:test";
import { storeOAuthState, verifyOAuthState } from "./oauth_state.ts";

class MemoryD1 {
  constructor() {
    this.map = new Map();
  }

  prepare(query) {
    const db = this;
    return {
      bind(...params) {
        return {
          run() {
            if (query.includes("DELETE FROM settings WHERE key LIKE")) {
              const prefix = String(params[0]).slice(0, -1);
              const now = Number(params[1]);
              let changes = 0;
              for (const [key, value] of db.map) {
                if (key.startsWith(prefix) && Number(value) <= now) {
                  db.map.delete(key);
                  changes += 1;
                }
              }
              return Promise.resolve({ meta: { changes } });
            }
            if (query.includes("INSERT OR REPLACE INTO settings")) {
              db.map.set(String(params[0]), String(params[1]));
              return Promise.resolve({ meta: { changes: 1 } });
            }
            if (query.includes("DELETE FROM settings WHERE key = ?")) {
              const key = String(params[0]);
              const expires = Number(db.map.get(key));
              const changes = Number.isFinite(expires) && expires > Number(params[1])
                ? (db.map.delete(key), 1)
                : 0;
              return Promise.resolve({ meta: { changes } });
            }
            throw new Error("unexpected query");
          },
        };
      },
    };
  }

  get(key) {
    return this.map.get(key);
  }
}

const makeCtx = (db) => ({ env: { DB: db } });

test("storeOAuthState + verifyOAuthState roundtrip", async () => {
  const db = new MemoryD1();
  const c = makeCtx(db);
  assert.equal(await storeOAuthState(c, "st_abc", "client_1"), true);
  assert.equal(db.get("oauth_state:st_abc:client_1") !== undefined, true);
  assert.equal(await verifyOAuthState(c, "st_abc", "client_1"), true);
});

test("verifyOAuthState is one-time and concurrent consumption is single-winner", async () => {
  const db = new MemoryD1();
  const c = makeCtx(db);
  await storeOAuthState(c, "st_ot", "client_1");
  const results = await Promise.all([
    verifyOAuthState(c, "st_ot", "client_1"),
    verifyOAuthState(c, "st_ot", "client_1"),
  ]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(await verifyOAuthState(c, "st_ot", "client_1"), false);
});

test("wrong clientID does not consume the state", async () => {
  const db = new MemoryD1();
  const c = makeCtx(db);
  await storeOAuthState(c, "st_attacker", "client_a");
  assert.equal(await verifyOAuthState(c, "st_attacker", "client_b"), false);
  assert.equal(await verifyOAuthState(c, "st_attacker", "client_a"), true);
});

test("expired state is rejected", async () => {
  const db = new MemoryD1();
  const c = makeCtx(db);
  await storeOAuthState(c, "st_exp", "client_1");
  db.map.set("oauth_state:st_exp:client_1", String(Date.now() - 1));
  assert.equal(await verifyOAuthState(c, "st_exp", "client_1"), false);
});

test("missing D1 binding fails closed", async () => {
  const c = makeCtx(null);
  assert.equal(await verifyOAuthState(c, "st", "client_1"), false);
  assert.equal(await storeOAuthState(c, "st", "client_1"), false);
});

test("D1 errors fail closed", async () => {
  const throwingDb = {
    prepare() {
      throw new Error("d1 down");
    },
  };
  const c = makeCtx(throwingDb);
  assert.equal(await storeOAuthState(c, "st", "client_1"), false);
  assert.equal(await verifyOAuthState(c, "st", "client_1"), false);
});

test("state key escapes state and client ID components", async () => {
  const db = new MemoryD1();
  const c = makeCtx(db);
  await storeOAuthState(c, "st:a", "client/b");
  assert.equal(db.get("oauth_state:st%3Aa:client%2Fb") !== undefined, true);
});
