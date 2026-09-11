import assert from "node:assert/strict";
import test from "node:test";
import { cursorPredicate, decodeEmailCursor, encodeEmailCursor } from "./cursor.ts";

test("email cursor round-trips sort key and stable id", () => {
  const encoded = encodeEmailCursor(1700000000123, "mail-uuid-1");
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeEmailCursor(encoded), {
    v: 1,
    sortKey: 1700000000123,
    id: "mail-uuid-1",
  });
});

test("cursorPredicate implements descending keyset tie-break", () => {
  const predicate = cursorPredicate({ v: 1, sortKey: 42, id: "m-2" });
  assert.equal(
    predicate.sql,
    "(COALESCE(internal_date, received_at) < ? OR (COALESCE(internal_date, received_at) = ? AND id < ?))",
  );
  assert.deepEqual(predicate.params, [42, 42, "m-2"]);
});

test("decodeEmailCursor fails closed on malformed or unsupported cursors", () => {
  for (const raw of ["", "%%%", "eyJ2IjoyLCJzb3J0S2V5IjoxLCJpZCI6IngifQ", "e30"]) {
    assert.throws(() => decodeEmailCursor(raw), /invalid cursor/);
  }
});

test("encodeEmailCursor rejects unsafe sort keys and oversized ids", () => {
  assert.throws(() => encodeEmailCursor(Number.MAX_SAFE_INTEGER + 1, "x"), /invalid cursor/);
  assert.throws(() => encodeEmailCursor(1, "x".repeat(257)), /invalid cursor/);
});
