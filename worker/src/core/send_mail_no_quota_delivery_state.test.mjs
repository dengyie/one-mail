import assert from "node:assert/strict";
import test from "node:test";

import { reserveSendMailLimit } from "../mails_api/send_mail_limit_utils.ts";

const CONFIG_KEY = "send_mail_limit_config";

class MemoryD1 {
  constructor(config) {
    this.settings = new Map();
    if (config !== undefined) this.settings.set(CONFIG_KEY, JSON.stringify(config));
    this.reservations = new Map();
  }

  prepare(sql) {
    return {
      run: async () => this.run(sql, []),
      bind: (...args) => ({
        first: async (column) => this.first(sql, args, column),
        run: async () => this.run(sql, args),
      }),
    };
  }

  async first(sql, args, column) {
    if (sql.includes("SELECT value FROM settings WHERE key = ?")) {
      const value = this.settings.get(args[0]) ?? null;
      return column ? value : (value === null ? null : { value });
    }
    return null;
  }

  async run(sql, args) {
    if (sql.startsWith("CREATE ")) return { meta: { changes: 0 } };

    if (sql.includes("UPDATE send_mail_limit_reservations SET status = 'released'") && sql.includes("expires_at <= ?")) {
      return { meta: { changes: 0 } };
    }

    if (sql.includes("INSERT INTO send_mail_limit_reservations")) {
      const [id, dailyKey, monthlyKey, dailyLimit, monthlyLimit, createdAt, updatedAt, expiresAt, idempotencyKey, requestHash] = args;
      this.reservations.set(id, {
        id,
        dailyKey,
        monthlyKey,
        dailyLimit,
        monthlyLimit,
        createdAt,
        updatedAt,
        expiresAt,
        idempotencyKey,
        requestHash,
        status: "active",
        dispatchState: "pending",
      });
      return { meta: { changes: 1 } };
    }

    throw new Error("Unhandled SQL in test double: " + sql);
  }
}

const context = (db) => ({
  env: { DB: db },
  get: () => "en",
});

for (const [name, config] of [
  ["missing quota configuration", undefined],
  ["disabled quota configuration", {
    dailyEnabled: false,
    monthlyEnabled: false,
    dailyLimit: null,
    monthlyLimit: null,
  }],
]) {
  test(`creates a durable delivery reservation with ${name}`, async () => {
    const db = new MemoryD1(config);
    const reservation = await reserveSendMailLimit(context(db));

    assert.ok(reservation, "provider dispatch must never proceed without a reservation");
    assert.equal(db.reservations.size, 1);
    const row = [...db.reservations.values()][0];
    assert.equal(row.dailyKey, null);
    assert.equal(row.monthlyKey, null);
    assert.equal(row.status, "active");
    assert.equal(row.dispatchState, "pending");
  });
}
