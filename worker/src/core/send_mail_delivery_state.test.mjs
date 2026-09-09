import assert from "node:assert/strict";
import test from "node:test";
import {
  hashSendMailRequest,
  reserveSendMailLimit,
  resolveUnknownSendMailReservation,
  SendMailIdempotencyConflictError,
} from "../mails_api/send_mail_limit_utils.ts";

const CONFIG_KEY = "send_mail_limit_config";

class DeliveryStateD1 {
  constructor() {
    this.settings = new Map([[CONFIG_KEY, JSON.stringify({
      dailyEnabled: true,
      monthlyEnabled: false,
      dailyLimit: 10,
      monthlyLimit: null,
    })]]);
    this.reservations = new Map();
  }

  prepare(sql) {
    return {
      bind: (...args) => ({
        first: async (column) => this.first(sql, args, column),
        run: async () => this.run(sql, args),
        all: async () => this.all(sql, args),
      }),
      first: async (column) => this.first(sql, [], column),
      run: async () => this.run(sql, []),
      all: async () => this.all(sql, []),
    };
  }

  async first(sql, args, column) {
    if (sql.includes("SELECT value FROM settings WHERE key = ?")) {
      const value = this.settings.get(args[0]) ?? null;
      return column ? value : (value === null ? null : { value });
    }
    if (sql.includes("WHERE idempotency_key = ?")) {
      const row = [...this.reservations.values()].find((item) => item.idempotencyKey === args[0]);
      return row ? {
        id: row.id,
        request_hash: row.requestHash,
        status: row.status,
        dispatch_state: row.dispatchState,
        sender_address: row.senderAddress,
        sender_address_id: row.senderAddressId,
        balance_reserved: row.balanceReserved,
        balance_refunded: row.balanceRefunded,
      } : null;
    }
    if (sql.includes("WHERE id = ?")) {
      const row = this.reservations.get(args[0]);
      return row ? {
        status: row.status,
        dispatch_state: row.dispatchState,
        sender_address: row.senderAddress,
        sender_address_id: row.senderAddressId,
        balance_reserved: row.balanceReserved,
        balance_refunded: row.balanceRefunded,
      } : null;
    }
    return null;
  }

  async all(sql, args) {
    if (sql.includes("dispatch_state = 'unknown'")) {
      return {
        results: [...this.reservations.values()]
          .filter((row) => row.status === "active" && row.dispatchState === "unknown")
          .slice(0, Number(args[0]))
          .map((row) => ({
            id: row.id,
            sender_address: row.senderAddress,
            balance_reserved: row.balanceReserved,
            idempotency_key: row.idempotencyKey,
            created_at: row.createdAt,
            updated_at: row.updatedAt,
            expires_at: row.expiresAt,
          })),
      };
    }
    return { results: [] };
  }

  async run(sql, args) {
    if (sql.startsWith("CREATE ")) return { meta: { changes: 0 } };
    if (sql.includes("UPDATE send_mail_limit_reservations SET status = 'released'")) {
      // 两类 SQL 共用 SET status = 'released' 子串，但参数契约不同：
      // ① releaseExpiredReservations 批量过期：args=[now, now, batchLimit]，SQL 含 WHERE id IN (SELECT...)。
      // ② resolveUnknownSendMailReservation(rejected) 单条释放：args=[now, id]，SQL 含 WHERE id = ?。
      // 必须精确分流，否则单条释放会误入批量分支（把 id 当 limit → NaN slice → changes=0）。
      if (!sql.includes("WHERE id IN (")) {
        // 单条释放：resolver rejected 分支的第二个 UPDATE
        const [updatedAt, id] = args;
        const row = this.reservations.get(id);
        if (!row || row.status !== "active" || row.dispatchState !== "pending") return { meta: { changes: 0 } };
        row.status = "released";
        row.updatedAt = updatedAt;
        this.decrement(row.dailyKey);
        return { meta: { changes: 1 } };
      }
      const [updatedAt, now, limit] = args;
      const rows = [...this.reservations.values()]
        .filter((row) => row.status === "active" && row.dispatchState === "pending" && row.expiresAt <= now)
        .sort((a, b) => a.expiresAt - b.expiresAt)
        .slice(0, Number(limit));
      for (const row of rows) {
        row.status = "released";
        row.updatedAt = updatedAt;
        this.decrement(row.dailyKey);
      }
      return { meta: { changes: rows.length } };
    }
    if (sql.includes("DELETE FROM send_mail_limit_reservations")) {
      const [id] = args;
      const row = this.reservations.get(id);
      if (row?.status === "released") this.reservations.delete(id);
      return { meta: { changes: row?.status === "released" ? 1 : 0 } };
    }
    if (sql.includes("INSERT INTO send_mail_limit_reservations")) {
      const [id, dailyKey, monthlyKey, dailyLimit, monthlyLimit, createdAt, updatedAt, expiresAt, idempotencyKey, requestHash] = args;
      if (idempotencyKey && [...this.reservations.values()].some((row) => row.idempotencyKey === idempotencyKey)) {
        throw new Error("UNIQUE constraint failed");
      }
      if (dailyKey && Number(this.settings.get(dailyKey) ?? 0) >= Number(dailyLimit)) {
        return { meta: { changes: 0 } };
      }
      this.reservations.set(id, {
        id, dailyKey, monthlyKey, idempotencyKey, requestHash,
        status: "active", dispatchState: "pending",
        senderAddress: null, senderAddressId: null, balanceReserved: 0, balanceRefunded: 0,
        createdAt, updatedAt, expiresAt,
      });
      this.increment(dailyKey);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("SET dispatch_state = ?")) {
      const [state, updatedAt, id, expected] = args;
      const row = this.reservations.get(id);
      if (!row || row.status !== "active" || row.dispatchState !== expected) return { meta: { changes: 0 } };
      row.dispatchState = state;
      row.updatedAt = updatedAt;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("SET sender_address = ?")) {
      const [address, addressId, updatedAt, id] = args;
      const row = this.reservations.get(id);
      if (!row || row.status !== "active" || row.balanceReserved) return { meta: { changes: 0 } };
      row.senderAddress = address;
      row.senderAddressId = addressId;
      row.balanceReserved = 1;
      row.balanceRefunded = 0;
      row.updatedAt = updatedAt;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("SET dispatch_state = 'sent', status = 'committed'")) {
      const [updatedAt, id] = args;
      const row = this.reservations.get(id);
      if (!row || row.status !== "active" || row.dispatchState !== "unknown") return { meta: { changes: 0 } };
      row.dispatchState = "sent";
      row.status = "committed";
      row.updatedAt = updatedAt;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("SET status = 'committed'")) {
      const [updatedAt, id] = args;
      const row = this.reservations.get(id);
      if (!row || row.status !== "active" || row.dispatchState !== "sent") return { meta: { changes: 0 } };
      row.status = "committed";
      row.updatedAt = updatedAt;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("SET dispatch_state = 'pending'")) {
      const [updatedAt, id] = args;
      const row = this.reservations.get(id);
      if (!row || row.status !== "active" || row.dispatchState !== "unknown") return { meta: { changes: 0 } };
      row.dispatchState = "pending";
      row.updatedAt = updatedAt;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("SET status = ?, updated_at = ?")) {
      const [status, updatedAt, id] = args;
      const row = this.reservations.get(id);
      if (!row || row.status !== "active") return { meta: { changes: 0 } };
      row.status = status;
      row.updatedAt = updatedAt;
      if (status === "released") this.decrement(row.dailyKey);
      return { meta: { changes: 1 } };
    }
    throw new Error("Unhandled SQL: " + sql);
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  increment(key) {
    if (key) this.settings.set(key, String(Number(this.settings.get(key) ?? 0) + 1));
  }

  decrement(key) {
    if (key) this.settings.set(key, String(Math.max(0, Number(this.settings.get(key) ?? 0) - 1)));
  }
}

const context = (db) => ({ env: { DB: db }, get: () => "en" });

test("idempotency key replays unknown and then sent without another reservation", async () => {
  const db = new DeliveryStateD1();
  const requestHash = await hashSendMailRequest({ address: "a@example.com", subject: "hello" });
  const reservation = await reserveSendMailLimit(context(db), {
    idempotencyKey: "key-1",
    requestHash,
  });
  assert.ok(reservation);
  await reservation.markDispatchStarted();
  const unknownReplay = await reserveSendMailLimit(context(db), {
    idempotencyKey: "key-1",
    requestHash,
  });
  assert.equal(unknownReplay?.replay, "unknown");
  await reservation.markDispatchSucceeded();
  await reservation.commit();
  const sentReplay = await reserveSendMailLimit(context(db), {
    idempotencyKey: "key-1",
    requestHash,
  });
  assert.equal(sentReplay?.replay, "sent");
  assert.equal(db.reservations.size, 1);
});

test("operator can resolve rejected unknown delivery and recover the quota slot", async () => {
  const db = new DeliveryStateD1();
  const reservation = await reserveSendMailLimit(context(db), {
    idempotencyKey: "key-2",
    requestHash: "hash-2",
  });
  assert.ok(reservation);
  await reservation.markBalanceReserved("a@example.com", "address-1");
  await reservation.markDispatchStarted();
  const row = [...db.reservations.values()][0];
  const result = await resolveUnknownSendMailReservation(context(db), row.id, "rejected");
  assert.deepEqual(result, { status: "released", refundAddress: "a@example.com", refundAddressId: "address-1" });
  assert.equal(db.settings.get(row.dailyKey), "0");
});


test("idempotency key rejects a different request hash", async () => {
  const db = new DeliveryStateD1();
  await reserveSendMailLimit(context(db), { idempotencyKey: "key-conflict", requestHash: "hash-a" });
  await assert.rejects(
    () => reserveSendMailLimit(context(db), { idempotencyKey: "key-conflict", requestHash: "hash-b" }),
    (error) => error instanceof SendMailIdempotencyConflictError,
  );
  assert.equal(db.reservations.size, 1);
});
