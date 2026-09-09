import assert from "node:assert/strict";
import test from "node:test";
import {
  storeOAuthState,
  verifyOAuthState,
  resolveOAuthState,
} from "../unified/oauth_state.ts";

async function oauth2CallbackGate(ctx, body, clientID) {
  const state = resolveOAuthState(body && body.state, ctx.queryState);
  if (!state) return 400;
  const valid = await verifyOAuthState(ctx, state, clientID);
  return valid ? 0 : 400;
}

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
}

const makeCtx = (db, queryState = undefined) => ({ env: { DB: db }, queryState });

test("R3: no state in body or query → rejected 400", async () => {
  const ctx = makeCtx(new MemoryD1());
  assert.equal(await oauth2CallbackGate(ctx, { code: "c", clientID: "client_1" }, "client_1"), 400);
});

test("R3: state from URL query works as fallback", async () => {
  const db = new MemoryD1();
  const ctx = makeCtx(db, "st_q");
  await storeOAuthState(ctx, "st_q", "client_1");
  assert.equal(await oauth2CallbackGate(ctx, { code: "c", clientID: "client_1" }, "client_1"), 0);
});

test("R3: state mismatch (nonexistent) → rejected 400", async () => {
  const ctx = makeCtx(new MemoryD1());
  assert.equal(await oauth2CallbackGate(ctx, { code: "c", clientID: "client_1", state: "nope" }, "client_1"), 400);
});

test("R3: mismatched clientID → rejected 400 and state remains usable", async () => {
  const db = new MemoryD1();
  const ctx = makeCtx(db);
  await storeOAuthState(ctx, "st_att", "client_a");
  assert.equal(await oauth2CallbackGate(ctx, { code: "c", clientID: "client_b", state: "st_att" }, "client_b"), 400);
  assert.equal(await oauth2CallbackGate(ctx, { code: "c", clientID: "client_a", state: "st_att" }, "client_a"), 0);
});

test("R3: valid state is consumed once under concurrent callbacks", async () => {
  const db = new MemoryD1();
  const ctx = makeCtx(db);
  await storeOAuthState(ctx, "st_ot", "client_1");
  const results = await Promise.all([
    oauth2CallbackGate(ctx, { code: "c", clientID: "client_1", state: "st_ot" }, "client_1"),
    oauth2CallbackGate(ctx, { code: "c", clientID: "client_1", state: "st_ot" }, "client_1"),
  ]);
  assert.deepEqual(results.sort(), [0, 400]);
});

test("R3: expired state → rejected 400", async () => {
  const db = new MemoryD1();
  const ctx = makeCtx(db);
  await storeOAuthState(ctx, "st_exp", "client_1");
  db.map.set("oauth_state:st_exp:client_1", String(Date.now() - 1));
  assert.equal(await oauth2CallbackGate(ctx, { code: "c", clientID: "client_1", state: "st_exp" }, "client_1"), 400);
});

test("R3: legacy frontend sends no state → rejected (fail-closed after upgrade)", async () => {
  const ctx = makeCtx(new MemoryD1());
  assert.equal(await oauth2CallbackGate(ctx, { code: "c", clientID: "client_1" }, "client_1"), 400);
});

test("R3: resolveOAuthState prioritizes body over query and normalizes empty", () => {
  assert.equal(resolveOAuthState("body-st", "query-st"), "body-st");
  assert.equal(resolveOAuthState(undefined, "query-st"), "query-st");
  assert.equal(resolveOAuthState("", "query-st"), "query-st");
  assert.equal(resolveOAuthState("", ""), "");
  assert.equal(resolveOAuthState(null, undefined), "");
});
