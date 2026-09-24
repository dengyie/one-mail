import assert from "node:assert/strict";
import test from "node:test";
import { getSplitStringListValue } from "../utils.ts";
import { getSendBalanceState } from "../mails_api/send_balance.ts";

test("getSplitStringListValue: string, array, empty parsing", () => {
  assert.deepEqual(getSplitStringListValue("admin,vip"), ["admin", "vip"]);
  assert.deepEqual(getSplitStringListValue("admin"), ["admin"]);
  assert.deepEqual(getSplitStringListValue(["admin", "vip"]), ["admin", "vip"]);
  assert.deepEqual(getSplitStringListValue(["admin"]), ["admin"]);
  assert.deepEqual(getSplitStringListValue(null), []);
  assert.deepEqual(getSplitStringListValue(undefined), []);
  assert.deepEqual(getSplitStringListValue(""), []);
});

test("getSendBalanceState: options.isAdmin grants unlimited balance", async () => {
  const mockContext = {
    env: {
      ADMIN_PASSWORDS: ["test_pass"],
      ADMIN_USER_ROLE: "admin",
      NO_LIMIT_SEND_ROLE: "admin",
      DEFAULT_SEND_BALANCE: 0,
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => null,
            run: async () => ({ meta: { changes: 0 } }),
          }),
        }),
      },
    },
    get: (key) => null,
    req: {
      raw: {
        headers: new Headers(),
      },
    },
  };

  const state = await getSendBalanceState(mockContext, "test@mangoqwq.com", {
    isAdmin: true,
  });

  assert.equal(state.isNoLimitSender, true);
  assert.equal(state.needCheckBalance, false);
  assert.equal(state.balance, 99999);
});

test("getSendBalanceState: ADMIN_USER_ROLE user grants unlimited balance", async () => {
  const mockContext = {
    env: {
      ADMIN_PASSWORDS: ["test_pass"],
      ADMIN_USER_ROLE: "admin",
      NO_LIMIT_SEND_ROLE: "",
      DEFAULT_SEND_BALANCE: 0,
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => null,
            run: async () => ({ meta: { changes: 0 } }),
          }),
        }),
      },
    },
    get: (key) => (key === "userRolePayload" ? "admin" : null),
    req: {
      raw: {
        headers: new Headers(),
      },
    },
  };

  const state = await getSendBalanceState(mockContext, "test@mangoqwq.com");

  assert.equal(state.isNoLimitSender, true);
  assert.equal(state.needCheckBalance, false);
  assert.equal(state.balance, 99999);
});

test("getSendBalanceState: NO_LIMIT_SEND_ROLE grants unlimited balance", async () => {
  const mockContext = {
    env: {
      ADMIN_PASSWORDS: ["test_pass"],
      ADMIN_USER_ROLE: "admin",
      NO_LIMIT_SEND_ROLE: "vip,admin",
      DEFAULT_SEND_BALANCE: 0,
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => null,
            run: async () => ({ meta: { changes: 0 } }),
          }),
        }),
      },
    },
    get: (key) => (key === "userRolePayload" ? "vip" : null),
    req: {
      raw: {
        headers: new Headers(),
      },
    },
  };

  const state = await getSendBalanceState(mockContext, "test@mangoqwq.com");

  assert.equal(state.isNoLimitSender, true);
  assert.equal(state.needCheckBalance, false);
  assert.equal(state.balance, 99999);
});
