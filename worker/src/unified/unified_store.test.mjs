import assert from "node:assert/strict";
import test from "node:test";
import { buildUnifiedEmailRow } from "./unified_store.ts";

test("buildUnifiedEmailRow maps parsed mail to a native provider row", () => {
  const parsed = {
    sender: "Alice <alice@example.com>",
    subject: "hi",
    text: "hello text",
    html: "<p>hello</p>",
    attachments: [
      { filename: "a.pdf", mimeType: "application/pdf", disposition: "attachment", content: new Uint8Array(3) },
      { filename: "b.png", mimeType: "image/png", disposition: "inline", content: new Uint8Array(5) },
    ],
  };
  const row = buildUnifiedEmailRow(parsed, "test@mangoqwq.com", "alice@example.com", 1700000000000, "id-1");

  assert.equal(row.id, "id-1");
  assert.equal(row.source, "cf_routing");
  assert.equal(row.account_id, "test@mangoqwq.com");
  assert.equal(row.from_addr, "alice@example.com");
  assert.equal(row.to_addr, "test@mangoqwq.com");
  assert.equal(row.subject, "hi");
  assert.equal(row.text_body, "hello text");
  assert.equal(row.html_body, "<p>hello</p>");
  assert.equal(row.received_at, 1700000000000);
  assert.equal(row.is_read, 0);
  assert.equal(row.imap_uid, null);
  assert.equal(row.provider, "native");
  assert.equal(row.source_folder, "INBOX");
  assert.equal(row.source_folder_id, null);
  assert.equal(row.provider_message_id, null);
  assert.equal(row.source_key, null); // never invent uniqueness from mutable RFC headers
  assert.equal(row.has_attachments, 1);
  assert.equal(row.sync_version, 1);
  const atts = JSON.parse(row.attachments_json);
  assert.deepEqual(atts, [
    { name: "a.pdf", size: 3, mimeType: "application/pdf" },
    { name: "b.png", size: 5, mimeType: "image/png" },
  ]);
});

test("buildUnifiedEmailRow tolerates missing parsed fields", () => {
  const row = buildUnifiedEmailRow(undefined, "t@x.com", "f@y.com", 1, "id-2");
  assert.equal(row.subject, "");
  assert.equal(row.text_body, "");
  assert.equal(row.attachments_json, "[]");
  assert.equal(row.has_attachments, 0);
  assert.equal(row.provider, "native");
});
