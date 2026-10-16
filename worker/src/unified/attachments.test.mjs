import assert from "node:assert/strict";
import test from "node:test";
import {
  attachmentKey,
  attachmentGcInsert,
  materializeAttachmentKeys,
  publicAttachmentJson,
  safeAttachmentKey,
  safeAttachmentName,
} from "./attachments.ts";

test("attachment keys are deterministic, opaque, and constrained", async () => {
  const first = await attachmentKey("account-a", "mail-a", "att-a");
  assert.equal(first, await attachmentKey("account-a", "mail-a", "att-a"));
  assert.match(first, /^unified\/[A-Za-z0-9_-]{43}$/);
  assert.equal(safeAttachmentKey(first), true);
  assert.notEqual(first, await attachmentKey("account-a", "mail-b", "att-a"));
});

test("attachment names replace lone UTF-16 surrogates before header encoding", () => {
  assert.equal(safeAttachmentName("bad\ud800name.txt"), "bad_name.txt");
});

test("long Unicode attachment names truncate on code-point boundaries and encode as RFC 5987", async () => {
  const { attachmentResponseHeaders } = await import("./attachments.ts");
  const name = safeAttachmentName(`${"a".repeat(254)}😀tail`);
  assert.equal(Array.from(name).length, 255);
  assert.equal(name.endsWith("😀"), true);
  const headers = attachmentResponseHeaders({ id: "att-1", name: "quote' (x)", size: 0, mimeType: "text/plain" });
  assert.match(headers.get("content-disposition"), /%27/);
  assert.match(headers.get("content-disposition"), /%28/);
});

test("ingest derives storage keys and ignores client supplied object keys", async () => {
  const json = await materializeAttachmentKeys(
    JSON.stringify([{ id: "att-1", name: "x.txt", size: 2, mimeType: "text/plain", storage_key: "unified/attacker" }]),
    "account-a",
    "mail-a",
  );
  const row = JSON.parse(json)[0];
  assert.equal(row.storage_key, await attachmentKey("account-a", "mail-a", "att-1"));
  assert.notEqual(row.storage_key, "unified/attacker");
});

test("ingest rejects malformed attachment metadata instead of silently dropping it", async () => {
  await assert.rejects(
    materializeAttachmentKeys("{bad", "account-a", "mail-a"),
    /invalid attachments_json/,
  );
  await assert.rejects(
    materializeAttachmentKeys(JSON.stringify({ id: "att-1" }), "account-a", "mail-a"),
    /attachments_json must be an array/,
  );
  await assert.rejects(
    materializeAttachmentKeys(JSON.stringify([null]), "account-a", "mail-a"),
    /invalid attachment metadata/,
  );
});

test("public email projections do not expose private storage keys", () => {
  const value = JSON.parse(publicAttachmentJson(JSON.stringify([
    { id: "att-1", name: "x.txt", storage_key: "unified/secret" },
  ])));
  assert.deepEqual(value, [{ id: "att-1", name: "x.txt", downloadable: false }]);
});

test("public email projections do not expose legacy R2 locators", () => {
  const value = JSON.parse(publicAttachmentJson(JSON.stringify([
    { id: "att-1", name: "x.txt", r2_key: "unified/legacy" },
  ])));
  assert.deepEqual(value, [{ id: "att-1", name: "x.txt", downloadable: false }]);
});

test("reupload refreshes the provisional attachment GC grace period", async () => {
  let query;
  let params;
  const env = {
    DB: {
      prepare(sql) {
        query = sql;
        return { bind(...values) { params = values; return { run: async () => ({}) }; } };
      },
    },
  };
  await attachmentGcInsert(env, "unified/key");
  assert.match(query, /ON CONFLICT\s*\(storage_key\)\s*DO UPDATE/i);
  assert.match(query, /updated_at\s*=\s*excluded\.updated_at/i);
  assert.match(query, /attempts\s*=\s*0/i);
  assert.match(query, /last_error\s*=\s*NULL/i);
  assert.equal(params[0], "unified/key");
  assert.equal(params[1], params[2]);
});
