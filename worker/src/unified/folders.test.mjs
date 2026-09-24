import assert from "node:assert/strict";
import test from "node:test";
import { listFolders } from "./folders.ts";

function createMockContext({ userAuth, apiKey, query = {} } = {}) {
  let executedSql = "";
  let executedBinds = [];

  return {
    req: {
      query(param) {
        return query[param];
      },
    },
    get(key) {
      if (key === "unifiedUserAuth") return userAuth;
      if (key === "apiKey") return apiKey;
      return undefined;
    },
    json(data, status = 200) {
      return { data, status };
    },
    env: {
      DB: {
        prepare(sql) {
          executedSql = sql;
          return {
            bind(...args) {
              executedBinds = args;
              return this;
            },
            async all() {
              return {
                results: [
                  {
                    id: 1,
                    account_id: "acct-1",
                    provider: "imap",
                    provider_folder_id: "INBOX",
                    canonical_name: "inbox",
                    display_name: "收件箱",
                    folder_type: "inbox",
                    uidvalidity: 123,
                  },
                ],
              };
            },
          };
        },
      },
    },
    getSql() {
      return executedSql;
    },
    getBinds() {
      return executedBinds;
    },
  };
}

test("listFolders defensive null-safety: userAuth with null userPayload returns empty results safely", async () => {
  const c = createMockContext({
    userAuth: {
      isAdmin: false,
      userPayload: null,
    },
  });

  const res = await listFolders(c);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { results: [] });
  // DB query should never execute when user_id is missing
  assert.equal(c.getSql(), "");
});

test("listFolders defensive null-safety: userAuth with missing user_id returns empty results safely", async () => {
  const c = createMockContext({
    userAuth: {
      isAdmin: false,
      userPayload: {},
    },
  });

  const res = await listFolders(c);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { results: [] });
  assert.equal(c.getSql(), "");
});

test("listFolders scopes non-admin user to user_mail_accounts", async () => {
  const c = createMockContext({
    userAuth: {
      isAdmin: false,
      userPayload: { user_id: 888 },
    },
  });

  const res = await listFolders(c);
  assert.equal(res.status, 200);
  assert.equal(res.data.results.length, 1);
  assert.match(c.getSql(), /user_mail_accounts/);
  assert.deepEqual(c.getBinds(), [888]);
});

test("listFolders allows admin user without user_mail_accounts filter", async () => {
  const c = createMockContext({
    userAuth: {
      isAdmin: true,
      userPayload: null,
    },
  });

  const res = await listFolders(c);
  assert.equal(res.status, 200);
  assert.doesNotMatch(c.getSql(), /user_mail_accounts/);
  assert.deepEqual(c.getBinds(), []);
});
