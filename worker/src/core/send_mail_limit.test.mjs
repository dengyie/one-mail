import assert from "node:assert/strict";
import test from "node:test";
import {
  reconcileSendMailLimitReservations,
  reserveSendMailLimit,
} from "../mails_api/send_mail_limit_utils.ts";

const CONFIG_KEY = "send_mail_limit_config";

class MemoryD1 {
  constructor(config) {
    this.settings = new Map([[CONFIG_KEY, JSON.stringify(config)]]);
    this.reservations = new Map();
    this.calls = [];
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
    if (sql.includes("SELECT value FROM settings WHERE key = ?")) {
      const value = this.settings.get(args[0]) ?? null;
      return column ? value : (value === null ? null : { value });
    }
    return null;
  }

  async run(sql, args) {
    this.calls.push({ sql, args });
    if (sql.startsWith("CREATE ")) {
      return { meta: { changes: 0 } };
    }

    if (sql.includes("UPDATE send_mail_limit_reservations SET status = 'released'")) {
      const [updatedAt, now, limit] = args;
      const expired = [...this.reservations.values()]
        .filter((row) => row.status === "active" && row.expiresAt <= now)
        .sort((a, b) => a.expiresAt - b.expiresAt || a.id.localeCompare(b.id))
        .slice(0, Number(limit));
      for (const row of expired) {
        row.status = "released";
        row.updatedAt = updatedAt;
        this.decrement(row.dailyKey);
        this.decrement(row.monthlyKey);
      }
      return { meta: { changes: expired.length } };
    }

    if (sql.includes("DELETE FROM send_mail_limit_reservations")) {
      const [before, limit] = args;
      const terminal = [...this.reservations.values()]
        .filter((row) => row.status !== "active" && row.updatedAt < before)
        .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))
        .slice(0, Number(limit));
      for (const row of terminal) this.reservations.delete(row.id);
      return { meta: { changes: terminal.length } };
    }

    if (sql.includes("INSERT INTO send_mail_limit_reservations")) {
      const [id, dailyKey, monthlyKey, dailyLimit, monthlyLimit, createdAt, updatedAt, expiresAt] = args;
      if (this.atLimit(dailyKey, dailyLimit) || this.atLimit(monthlyKey, monthlyLimit)) {
        return { meta: { changes: 0 } };
      }
      this.reservations.set(id, {
        id,
        dailyKey,
        monthlyKey,
        status: "active",
        createdAt,
        updatedAt,
        expiresAt,
      });
      this.increment(dailyKey);
      this.increment(monthlyKey);
      return { meta: { changes: 1 } };
    }

    if (sql.includes("UPDATE send_mail_limit_reservations SET status = ?, updated_at = ?")) {
      const [status, updatedAt, id] = args;
      const row = this.reservations.get(id);
      if (!row || row.status !== "active") {
        return { meta: { changes: 0 } };
      }
      row.status = status;
      row.updatedAt = updatedAt;
      if (status === "released") {
        this.decrement(row.dailyKey);
        this.decrement(row.monthlyKey);
      }
      return { meta: { changes: 1 } };
    }

    throw new Error("Unhandled SQL in test double: " + sql);
  }

  atLimit(key, limit) {
    return key !== null && Number(this.settings.get(key) ?? "0") >= Number(limit);
  }

  increment(key) {
    if (key === null) return;
    this.settings.set(key, String(Number(this.settings.get(key) ?? "0") + 1));
  }

  decrement(key) {
    if (key === null) return;
    this.settings.set(key, String(Math.max(0, Number(this.settings.get(key) ?? "0") - 1)));
  }

  countFor(prefix) {
    const [key] = [...this.settings.keys()].filter((value) => value.startsWith(prefix));
    return key ? Number(this.settings.get(key)) : 0;
  }
}

const context = (db) => ({
  env: { DB: db },
  get: () => "en",
});

test("released reservation returns its slots and is idempotent", async () => {
  const db = new MemoryD1({
    dailyEnabled: true,
    monthlyEnabled: true,
    dailyLimit: 1,
    monthlyLimit: 2,
  });
  const reservation = await reserveSendMailLimit(context(db));
  assert.ok(reservation);
  assert.equal(db.countFor("send_mail_limit_count:daily:"), 1);
  assert.equal(db.countFor("send_mail_limit_count:monthly:"), 1);

  await reservation.release();
  await reservation.release();
  assert.equal(db.countFor("send_mail_limit_count:daily:"), 0);
  assert.equal(db.countFor("send_mail_limit_count:monthly:"), 0);

  const retry = await reserveSendMailLimit(context(db));
  assert.ok(retry);
  await retry.commit();
  await retry.commit();
  assert.equal(db.countFor("send_mail_limit_count:daily:"), 1);
  assert.equal(db.countFor("send_mail_limit_count:monthly:"), 1);
});

test("expired active reservations are recovered by the reconciler", async () => {
  const db = new MemoryD1({
    dailyEnabled: true,
    monthlyEnabled: false,
    dailyLimit: 1,
    monthlyLimit: null,
  });
  const reservation = await reserveSendMailLimit(context(db));
  assert.ok(reservation);
  const row = [...db.reservations.values()][0];
  row.expiresAt = 0;

  const result = await reconcileSendMailLimitReservations({ DB: db }, 1_000, 100);
  assert.deepEqual(result, { released: 1, purged: 0 });
  assert.equal(db.countFor("send_mail_limit_count:daily:"), 0);

  const retry = await reserveSendMailLimit(context(db));
  assert.ok(retry);
});

test("atomic guard reports a reached daily limit without leaking a row", async () => {
  const db = new MemoryD1({
    dailyEnabled: true,
    monthlyEnabled: false,
    dailyLimit: 1,
    monthlyLimit: null,
  });
  const first = await reserveSendMailLimit(context(db));
  assert.ok(first);
  await assert.rejects(
    reserveSendMailLimit(context(db)),
    /Server daily send quota has been reached/,
  );
  assert.equal(db.reservations.size, 1);
  await first.release();
  assert.equal(db.countFor("send_mail_limit_count:daily:"), 0);
});
