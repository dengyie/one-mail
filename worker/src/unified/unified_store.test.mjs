import assert from "node:assert/strict";
import test from "node:test";
import { buildUnifiedEmailRow } from "./unified_store.ts";

test("buildUnifiedEmailRow maps parsed mail to an emails row with cf_routing source", () => {
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
  assert.equal(row.account_id, "test@mangoqwq.com");     // CF 侧 account = 收件地址
  assert.equal(row.from_addr, "alice@example.com");
  assert.equal(row.to_addr, "test@mangoqwq.com");
  assert.equal(row.subject, "hi");
  assert.equal(row.text_body, "hello text");
  assert.equal(row.html_body, "<p>hello</p>");
  assert.equal(row.received_at, 1700000000000);
  assert.equal(row.is_read, 0);
  assert.equal(row.imap_uid, null);
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
});