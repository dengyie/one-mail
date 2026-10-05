import assert from "node:assert/strict";
import test from "node:test";

import {
  consumePasskeyChallenge,
  resolvePasskeyRpContext,
  storePasskeyChallenge,
} from "../user_api/passkey_security.ts";

class MemoryD1 {
  constructor() {
    this.challenges = new Map();
  }

  prepare(sql) {
    return {
      bind: (...args) => ({ run: async () => this.run(sql, args) }),
    };
  }

  async run(sql, args) {
    if (sql.includes("DELETE FROM passkey_challenges") && sql.includes("expires_at <=")) {
      const [now] = args;
      let changes = 0;
      for (const [key, row] of [...this.challenges.entries()]) {
        if (row.expiresAt <= Number(now)) {
          this.challenges.delete(key);
          changes += 1;
        }
      }
      return { meta: { changes } };
    }

    if (sql.startsWith("INSERT OR REPLACE INTO passkey_challenges")) {
      const [key, expiresAt, createdAt] = args;
      this.challenges.set(key, { expiresAt: Number(expiresAt), createdAt: Number(createdAt) });
      return { meta: { changes: 1 } };
    }

    if (sql.includes("DELETE FROM passkey_challenges") && sql.includes("challenge_key = ?")) {
      const [key, now] = args;
      const row = this.challenges.get(key);
      if (!row || row.expiresAt <= Number(now)) return { meta: { changes: 0 } };
      this.challenges.delete(key);
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
  assert.equal(
    resolvePasskeyRpContext(null, undefined),
    null,
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
