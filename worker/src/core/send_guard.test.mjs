import assert from "node:assert/strict";
import test from "node:test";
import { recipientIsBlocked, singleHeaderValue, threadingHeaders } from "./send_guard.ts";
import { createMimeMessage } from "mimetext";

test("the send block list matches a recipient substring and ignores malformed entries", () => {
  assert.equal(recipientIsBlocked("person@spam.test", ["spam.test"]), true);
  assert.equal(recipientIsBlocked("person@ok.test", ["spam.test"]), false);
  assert.equal(recipientIsBlocked("person@ok.test", null), false);
  assert.equal(recipientIsBlocked("person@ok.test", ["", 1]), false);
});

test("a threading header that contains a line break is dropped before it can start another header", () => {
  assert.equal(singleHeaderValue("<p@example.com>\r\nBcc: hidden@example.com"), undefined);
  assert.equal(singleHeaderValue("  <p@example.com>  "), "<p@example.com>");
  const headers = threadingHeaders({
    in_reply_to: "<p@example.com>\r\nBcc: hidden@example.com",
    references: ["<root@example.com>", "<mid@example.com>\nBcc: hidden@example.com"],
  });
  assert.deepEqual(headers, { References: "<root@example.com>" });
  const msg = createMimeMessage();
  msg.setSender("a@mangoqwq.com");
  msg.setRecipient("b@example.com");
  msg.setSubject("hi");
  for (const [name, value] of Object.entries(headers)) {
    msg.setHeader(name, value);
  }
  msg.addMessage({ contentType: "text/plain", data: "body" });
  const raw = msg.asRaw();
  assert.equal(raw.includes("Bcc:"), false);
  assert.equal(raw.includes("hidden@example.com"), false);
});
