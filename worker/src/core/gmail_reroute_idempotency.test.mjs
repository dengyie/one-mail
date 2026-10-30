import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { GMAIL_REROUTE_IDEMPOTENCY_SCHEMA } from "./gmail_reroute_idempotency.ts";

const MIGRATION = new URL("../../../db/2026-10-29-gmail-reroute-idempotency.sql", import.meta.url);

/**
 * Compare the two copies of the shape, not their formatting: strip SQL line
 * comments, collapse whitespace, drop the terminator and normalize the spacing
 * around parentheses and commas.
 */
function normalize(sql) {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\(\s/g, "(")
    .replace(/\s\)/g, ")")
    .replace(/\s*,\s*/g, ", ")
    .replace(/;\s*$/, "")
    .trim()
    .toLowerCase();
}

test("the runtime schema matches the migration, so the two copies cannot drift", async () => {
  const migration = await readFile(MIGRATION, "utf8");
  assert.equal(
    normalize(GMAIL_REROUTE_IDEMPOTENCY_SCHEMA),
    normalize(migration),
    "update both the migration and the runtime fallback, or the send path silently creates the old shape",
  );
});

test("the runtime schema still carries every column the send path writes", () => {
  for (const column of ["idempotency_key TEXT PRIMARY KEY", "request_hash TEXT NOT NULL", "job_id TEXT NOT NULL", "created_at INTEGER NOT NULL"]) {
    assert.ok(
      GMAIL_REROUTE_IDEMPOTENCY_SCHEMA.includes(column),
      `missing ${column}`,
    );
  }
});
