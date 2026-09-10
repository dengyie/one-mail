import assert from "node:assert/strict";
import test from "node:test";

import {
  consumeRegistrationVerifyCode,
  generateRegistrationVerifyCode,
  reserveRegistrationVerifyCode,
} from "../user_api/registration_verify_code.ts";

class MemoryD1 {
  constructor() {
    this.settings = new Map();
  }

  prepare(sql) {
    return {
      bind: (...args) => ({
        first: async (column) => this.first(sql, args, column),
        run: async () => this.run(sql, args),
      }),
    };
  }

  async first(sql, args, column) {
    if (sql.startsWith("SELECT value FROM settings WHERE key = ?")) {
      const value = this.settings.get(args[0]) ?? null;
      return column ? value : (value == null ? null : { value });
    }
    throw new Error(`Unhandled SELECT: ${sql}`);
  }

  async run(sql, args) {
    if (sql.startsWith("DELETE FROM settings WHERE key = ? AND CAST(substr")) {
      const [key, now] = args;
      const value = this.settings.get(key);
      if (value == null) return { meta: { changes: 0 } };
      const expiry = Number(String(value).split(":", 1)[0]);
      if (expiry <= Number(now)) {
        this.settings.delete(key);
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }

    if (sql.startsWith("INSERT OR IGNORE INTO settings")) {
      const [key, value] = args;
      if (this.settings.has(key)) return { meta: { changes: 0 } };
      this.settings.set(key, value);
      return { meta: { changes: 1 } };
    }

    if (sql.startsWith("DELETE FROM settings WHERE key = ? AND value = ?")) {
      const [key, expected] = args;
      if (this.settings.get(key) !== expected) return { meta: { changes: 0 } };
      this.settings.delete(key);
      return { meta: { changes: 1 } };
    }

    throw new Error(`Unhandled SQL: ${sql}`);
  }
}

test("verification codes are six-digit Web Crypto values", () => {
  for (let i = 0; i < 100; i += 1) {
    const code = generateRegistrationVerifyCode();
    assert.match(code, /^\d{6}$/);
    assert.ok(Number(code) >= 100000 && Number(code) <= 999999);
  }
});

test("reserved verification code is HMACed, single-use, and wrong codes do not consume it", async () => {
  const db = new MemoryD1();
  const secret = "test-secret";
  const email = "user@example.com";
  const code = "123456";
  const now = 1_000;

  assert.equal(await reserveRegistrationVerifyCode(db, secret, email, code, now), true);
  const stored = [...db.settings.values()][0];
  assert.equal(String(stored).includes(code), false);

  assert.equal(await consumeRegistrationVerifyCode(db, secret, email, "654321", now + 1), false);
  assert.equal(db.settings.size, 1);
  assert.equal(await consumeRegistrationVerifyCode(db, secret, email, code, now + 2), true);
  assert.equal(await consumeRegistrationVerifyCode(db, secret, email, code, now + 3), false);
});

test("concurrent consumers cannot both use the same verification code", async () => {
  const db = new MemoryD1();
  const secret = "test-secret";
  const email = "race@example.com";
  const code = "234567";

  assert.equal(await reserveRegistrationVerifyCode(db, secret, email, code, 10_000), true);
  const results = await Promise.all([
    consumeRegistrationVerifyCode(db, secret, email, code, 10_001),
    consumeRegistrationVerifyCode(db, secret, email, code, 10_001),
  ]);
  assert.deepEqual(results.sort(), [false, true]);
});

test("active code blocks resend but an expired code can be replaced", async () => {
  const db = new MemoryD1();
  const secret = "test-secret";
  const email = "retry@example.com";

  assert.equal(await reserveRegistrationVerifyCode(db, secret, email, "345678", 0), true);
  assert.equal(await reserveRegistrationVerifyCode(db, secret, email, "456789", 1), false);
  assert.equal(await reserveRegistrationVerifyCode(db, secret, email, "456789", 5 * 60 * 1000 + 1), true);
  assert.equal(await consumeRegistrationVerifyCode(db, secret, email, "345678", 5 * 60 * 1000 + 2), false);
  assert.equal(await consumeRegistrationVerifyCode(db, secret, email, "456789", 5 * 60 * 1000 + 2), true);
});
