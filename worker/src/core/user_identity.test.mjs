import assert from "node:assert/strict";
import test from "node:test";
import { isActiveUser } from "./user_identity.ts";

const makeDb = (row, onFirst = undefined) => {
  const calls = [];
  return {
    calls,
    prepare(query) {
      return {
        bind(...params) {
          return {
            first: async (column) => {
              calls.push({ query, params, column });
              if (onFirst) await onFirst();
              return row;
            },
          };
        },
      };
    },
  };
};

test("matching id and email identifies the live user", async () => {
  const db = makeDb({ id: 7 });
  assert.equal(await isActiveUser(db, 7, "alice@example.com"), true);
  assert.equal(db.calls[0].params[0], 7);
  assert.equal(db.calls[0].params[1], "alice@example.com");
  assert.match(db.calls[0].query, /id = \? AND user_email = \?/);
});

test("same id with a different email is rejected (id reuse)", async () => {
  const db = makeDb(null);
  assert.equal(await isActiveUser(db, 7, "old@example.com"), false);
});

test("legacy token without email and malformed IDs fail closed", async () => {
  const db = makeDb({ id: 7 });
  assert.equal(await isActiveUser(db, 7, undefined), false);
  assert.equal(await isActiveUser(db, Number.NaN, "alice@example.com"), false);
  assert.equal(await isActiveUser(db, 0, "alice@example.com"), false);
  assert.equal(await isActiveUser(db, "", "alice@example.com"), false);
  assert.equal(db.calls.length, 0);
});

test("database errors fail closed", async () => {
  const db = makeDb(null, async () => { throw new Error("d1 down"); });
  assert.equal(await isActiveUser(db, 7, "alice@example.com"), false);
});
