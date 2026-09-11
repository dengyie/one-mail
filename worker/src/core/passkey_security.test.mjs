import assert from "node:assert/strict";
import test from "node:test";

import {
  consumePasskeyChallenge,
  resolvePasskeyRpContext,
  storePasskeyChallenge,
} from "../user_api/passkey_security.ts";

class MemoryD1 {
  constructor() {
    this.settings = new Map();
  }

  prepare(sql) {
    return {
      bind: (...args) => ({ run: async () => this.run(sql, args) }),
    };
  }

  async run(sql, args) {
    if (sql.startsWith("DELETE FROM settings WHERE key LIKE")) {
      const [, now] = args;
      let changes = 0;
      for (const [key, value] of [...this.settings.entries()]) {
        if (key.startsWith("passkey_challenge:") && Number(value) <= Number(now)) {
          this.settings.delete(key);
          changes += 1;
        }
      }
      return { meta: { changes } };
    }

    if (sql.startsWith("INSERT OR REPLACE INTO settings")) {
      const [key, value] = args;
      this.settings.set(key, value);
      return { meta: { changes: 1 } };
    }

    if (sql.startsWith("DELETE FROM settings WHERE key = ?")) {
      const [key, now] = args;
      const expiry = this.settings.get(key);
      if (expiry == null || Number(expiry) <= Number(now)) {
        return { meta: { changes: 0 } };
      }
      this.settings.delete(key);
      return { meta: { changes: 1 } };
    }

    throw new Error(`Unhandled SQL: ${sql}`);
  }
}

test("passkey RP context accepts only exact server-trusted origins", () => {
  assert.deepEqual(
    resolvePasskeyRpContext("https://inbox.mangoqwq.com"),
    { origin: "https://inbox.mangoqwq.com", rpID: "inbox.mangoqwq.com" },
  );
  assert.deepEqual(
    resolvePasskeyRpContext("https://custom.example.com", "https://custom.example.com"),
    { origin: "https://custom.example.com", rpID: "custom.example.com" },
  );

  assert.equal(resolvePasskeyRpContext("https://evil.mangoqwq.com"), null);
  assert.equal(resolvePasskeyRpContext("http://custom.example.com", "http://custom.example.com"), null);
  assert.equal(resolvePasskeyRpContext(null), null);
});

test("passkey challenge is single-use and bound to purpose, RP and registration user", async () => {
  const db = new MemoryD1();
  const rp = { origin: "https://inbox.mangoqwq.com", rpID: "inbox.mangoqwq.com" };
  const otherRp = { origin: "https://mail.mangoqwq.com", rpID: "mail.mangoqwq.com" };
  const now = 1_000;

  assert.equal(await storePasskeyChallenge(db, "register", "challenge-1", rp, 7, now), true);
  assert.equal(await consumePasskeyChallenge(db, "register", "challenge-1", rp, 8, now + 1), false);
  assert.equal(await consumePasskeyChallenge(db, "authenticate", "challenge-1", rp, 7, now + 1), false);
  assert.equal(await consumePasskeyChallenge(db, "register", "challenge-1", otherRp, 7, now + 1), false);
  assert.equal(await consumePasskeyChallenge(db, "register", "challenge-1", rp, 7, now + 1), true);
  assert.equal(await consumePasskeyChallenge(db, "register", "challenge-1", rp, 7, now + 2), false);
});

test("expired passkey challenge cannot be consumed", async () => {
  const db = new MemoryD1();
  const rp = { origin: "http://localhost:5173", rpID: "localhost" };

  assert.equal(await storePasskeyChallenge(db, "authenticate", "challenge-2", rp, undefined, 0), true);
  assert.equal(
    await consumePasskeyChallenge(db, "authenticate", "challenge-2", rp, undefined, 5 * 60 * 1000 + 1),
    false,
  );
});
