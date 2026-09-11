import assert from "node:assert/strict";
import test from "node:test";

import { checkRowAccess, resolveScopedEmailFilter } from "./auth_scope.ts";

const userAuth = (userId, isAdmin = false) => ({
  userPayload: { user_id: userId, user_email: `u${userId}@example.test`, exp: 9999999999, iat: 1 },
  isAdmin,
  userRole: isAdmin ? "admin" : "user",
});

const makeContext = ({ auth, apiKey, accountOwners = {}, nativeAddressOwners = {} } = {}) => ({
  get(key) {
    if (key === "unifiedUserAuth") return auth;
    if (key === "apiKey") return apiKey;
    return undefined;
  },
  env: {
    DB: {
      prepare(sql) {
        let binds = [];
        return {
          bind(...args) {
            binds = args;
            return this;
          },
          async first(column) {
            assert.match(sql, /user_mail_accounts/);
            const [accountId, accountUserId, source, addressUserId, toAddr] = binds;
            const ownsAccount = accountOwners[accountId] === accountUserId;
            const ownsNativeAddress = source === "cf_routing"
              && (nativeAddressOwners[toAddr] ?? []).includes(addressUserId);
            const allowed = ownsAccount || ownsNativeAddress ? 1 : 0;
            return column ? allowed : { allowed };
          },
        };
      },
    },
  },
});

test("non-admin query is scoped by account ownership plus native-address ownership", async () => {
  const c = makeContext({ auth: userAuth(42) });
  const filter = await resolveScopedEmailFilter(c, { source: "imap_gmail", unread: "1" });

  assert.match(filter.where, /source = \?/);
  assert.match(filter.where, /user_mail_accounts uma/);
  assert.match(filter.where, /uma\.id = emails\.account_id AND uma\.user_id = \?/);
  assert.match(filter.where, /emails\.source = 'cf_routing'/);
  assert.match(filter.where, /a\.name = emails\.to_addr/);
  assert.match(filter.where, /source_meta != 'external'/);
  assert.doesNotMatch(filter.where, /enabled\s*=\s*1/);
  assert.deepEqual(filter.params, ["imap_gmail", 42, 42]);
});

test("admin user keeps business filters without tenant ownership predicate", async () => {
  const c = makeContext({ auth: userAuth(1, true) });
  const filter = await resolveScopedEmailFilter(c, { account_id: "acct-1" });

  assert.equal(filter.where, "1=1 AND account_id = ?");
  assert.deepEqual(filter.params, ["acct-1"]);
  assert.doesNotMatch(filter.where, /user_mail_accounts/);
});

test("readonly API key keeps source/account whitelist scoping", async () => {
  const c = makeContext({
    apiKey: {
      role: "readonly",
      allowed_sources: '["imap_qq"]',
      allowed_accounts: '["acct-a"]',
    },
  });
  const filter = await resolveScopedEmailFilter(c, {});

  assert.match(filter.where, /source = \?/);
  assert.match(filter.where, /account_id = \?/);
  assert.deepEqual(filter.params, ["imap_qq", "acct-a"]);
});

test("missing verified auth context fails closed", async () => {
  const filter = await resolveScopedEmailFilter(makeContext(), {});
  assert.deepEqual(filter, { where: "0=1", params: [] });
});

test("external row access follows account_id owner, not to_addr", async () => {
  const c = makeContext({
    auth: userAuth(10),
    accountOwners: { "acct-owned": 10, "acct-other": 20 },
    nativeAddressOwners: { "shared@example.test": [10] },
  });

  assert.equal(await checkRowAccess(c, {
    source: "imap_gmail",
    account_id: "acct-owned",
    to_addr: "alias-that-does-not-match@gmail.test",
  }), true);

  // Same to_addr is a native address owned by user 10, but the external account belongs
  // to user 20. to_addr must not be able to grant external-mail access.
  assert.equal(await checkRowAccess(c, {
    source: "imap_gmail",
    account_id: "acct-other",
    to_addr: "shared@example.test",
  }), false);
});

test("native cf_routing row access follows bound site address", async () => {
  const c = makeContext({
    auth: userAuth(10),
    nativeAddressOwners: {
      "owned@mango.test": [10],
      "other@mango.test": [20],
    },
  });

  assert.equal(await checkRowAccess(c, {
    source: "cf_routing",
    account_id: "owned@mango.test",
    to_addr: "owned@mango.test",
  }), true);
  assert.equal(await checkRowAccess(c, {
    source: "cf_routing",
    account_id: "other@mango.test",
    to_addr: "other@mango.test",
  }), false);
});

test("admin row access bypasses business ownership but anonymous context never does", async () => {
  assert.equal(await checkRowAccess(makeContext({ auth: userAuth(1, true) }), {
    source: "imap_gmail",
    account_id: "any",
    to_addr: "any@example.test",
  }), true);

  assert.equal(await checkRowAccess(makeContext(), {
    source: "imap_gmail",
    account_id: "any",
    to_addr: "any@example.test",
  }), false);
});
