import assert from "node:assert/strict";
import test from "node:test";

import {
  OUTBOUND_PROVIDERS,
  OUTBOUND_STATUSES,
  computeOutboundRequestHash,
  isOutboundProvider,
  isOutboundStatus,
  forceGmailReplyRoute,
  providerForAccountSource,
  validateOutboundPayload,
} from "./outbound_mail.ts";

const validPayload = {
  from_addr: "me@qq.com",
  from_name: "Me",
  to_mail: "someone@example.com",
  to_name: "Someone",
  subject: "Hello",
  content: "Hi there",
  is_html: false,
};

test("provider and status constants are exhaustive", () => {
  assert.deepEqual(OUTBOUND_PROVIDERS, [
    "imap_qq",
    "imap_163",
    "imap_gmail",
    "imap_outlook",
    "graph_outlook",
    "imap_custom",
  ]);
  assert.deepEqual(OUTBOUND_STATUSES, [
    "pending",
    "processing",
    "succeeded",
    "failed",
    "unsupported",
    "superseded",
  ]);
});

test("guards accept known values and reject unknown ones", () => {
  assert.ok(isOutboundProvider("imap_qq"));
  assert.ok(isOutboundProvider("graph_outlook"));
  assert.equal(isOutboundProvider("smtp"), false);
  assert.equal(isOutboundProvider(42), false);

  assert.ok(isOutboundStatus("succeeded"));
  assert.equal(isOutboundStatus("queued"), false);
  assert.equal(isOutboundStatus(null), false);
});

test("validateOutboundPayload accepts a well-formed request", () => {
  const result = validateOutboundPayload(validPayload);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.from_addr, "me@qq.com");
    assert.equal(result.value.to_mail, "someone@example.com");
    assert.equal(result.value.is_html, false);
  }
});

test("validateOutboundPayload rejects non-object input", () => {
  const result = validateOutboundPayload(null);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /JSON object/);
  }
  assert.equal(validateOutboundPayload([]).ok, false);
  assert.equal(validateOutboundPayload("text").ok, false);
});

test("validateOutboundPayload requires valid from and to addresses", () => {
  assert.equal(
    validateOutboundPayload({ ...validPayload, from_addr: "" }).ok,
    false,
  );
  assert.equal(
    validateOutboundPayload({ ...validPayload, from_addr: "not-an-email" }).ok,
    false,
  );
  assert.equal(
    validateOutboundPayload({ ...validPayload, to_mail: "nope" }).ok,
    false,
  );
});

test("validateOutboundPayload requires subject and content", () => {
  assert.equal(
    validateOutboundPayload({ ...validPayload, subject: "   " }).ok,
    false,
  );
  assert.equal(
    validateOutboundPayload({ ...validPayload, content: "" }).ok,
    false,
  );
});

test("validateOutboundPayload requires boolean is_html", () => {
  assert.equal(
    validateOutboundPayload({ ...validPayload, is_html: "yes" }).ok,
    false,
  );
});

test("validateOutboundPayload keeps optional threading headers", () => {
  const result = validateOutboundPayload({
    ...validPayload,
    in_reply_to: "<parent@example.com>",
    references: ["<root@example.com>", "<parent@example.com>", "  ", 12],
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.in_reply_to, "<parent@example.com>");
    assert.deepEqual(result.value.references, [
      "<root@example.com>",
      "<parent@example.com>",
    ]);
  }
});

test("validateOutboundPayload omits blank threading headers", () => {
  const result = validateOutboundPayload({
    ...validPayload,
    in_reply_to: "   ",
    references: [],
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.in_reply_to, undefined);
    assert.equal(result.value.references, undefined);
  }
});

test("computeOutboundRequestHash is deterministic and account-scoped", async () => {
  const first = await computeOutboundRequestHash({
    account_id: "acct-1",
    payload: validPayload,
  });
  const second = await computeOutboundRequestHash({
    account_id: "acct-1",
    payload: validPayload,
  });
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);

  const otherAccount = await computeOutboundRequestHash({
    account_id: "acct-2",
    payload: validPayload,
  });
  assert.notEqual(first, otherAccount);

  const otherContent = await computeOutboundRequestHash({
    account_id: "acct-1",
    payload: { ...validPayload, content: "Different body" },
  });
  assert.notEqual(first, otherContent);
});

test("validateOutboundPayload keeps a hex Gmail thread id and drops a decimal X-GM-THRID", () => {
  const kept = validateOutboundPayload({
    ...validPayload,
    reply_to_email_id: "mail-1",
    provider_thread_id: "18BB368A913AD11A",
  });
  assert.equal(kept.ok, true);
  if (kept.ok) {
    assert.equal(kept.value.reply_to_email_id, "mail-1");
    assert.equal(kept.value.provider_thread_id, "18bb368a913ad11a");
  }
  const decimal = validateOutboundPayload({
    ...validPayload,
    provider_thread_id: "1781312345678901234",
  });
  assert.equal(decimal.ok, true);
  if (decimal.ok) {
    assert.equal(decimal.value.provider_thread_id, undefined);
  }
  const dropped = validateOutboundPayload({
    ...validPayload,
    provider_thread_id: "<parent@gmail.com>",
  });
  assert.equal(dropped.ok, true);
  if (dropped.ok) {
    assert.equal(dropped.value.provider_thread_id, undefined);
  }
});

test("validateOutboundPayload rejects a threading header that contains a line break", () => {
  const broken = validateOutboundPayload({
    ...validPayload,
    in_reply_to: "<parent@example.com>\r\nBcc: victim@example.com",
  });
  assert.equal(broken.ok, false);
  const brokenReference = validateOutboundPayload({
    ...validPayload,
    references: ["<root@example.com>\nBcc: victim@example.com"],
  });
  assert.equal(brokenReference.ok, false);
});

test("a Gmail original is routed as its owning account even when another account was requested", () => {
  const routed = forceGmailReplyRoute(
    {
      account_id: "acct-a",
      source: "imap_gmail",
      provider_thread_id: "18BB368A913AD11A",
      message_id_header: "<parent@gmail.com>",
    },
    { id: "acct-a", username: "a@gmail.com" },
    { ...validPayload, from_addr: "b@163.com", reply_to_email_id: "mail-gmail" },
  );
  assert.equal(routed.accountId, "acct-a");
  assert.equal(routed.payload.from_addr, "a@gmail.com");
  assert.equal(routed.payload.provider_thread_id, "18bb368a913ad11a");
  assert.equal(routed.payload.in_reply_to, "<parent@gmail.com>");
  assert.equal(forceGmailReplyRoute(
    { account_id: "local", source: "cf_routing", provider_thread_id: null, message_id_header: null },
    { id: "acct-b", username: "b@163.com" },
    validPayload,
  ), null);
  assert.equal(forceGmailReplyRoute(
    { account_id: "acct-a", source: "imap_gmail", provider_thread_id: "63", message_id_header: null },
    null,
    validPayload,
  ), null);
});

test("computeOutboundRequestHash changes when the Gmail thread id changes", async () => {
  const first = await computeOutboundRequestHash({
    account_id: "acct-1",
    payload: { ...validPayload, provider_thread_id: "ab" },
  });
  const second = await computeOutboundRequestHash({
    account_id: "acct-1",
    payload: { ...validPayload, provider_thread_id: "cd" },
  });
  assert.notEqual(first, second);
});

test("computeOutboundRequestHash changes when threading headers change", async () => {
  const plain = await computeOutboundRequestHash({
    account_id: "acct-1",
    payload: validPayload,
  });
  const reply = await computeOutboundRequestHash({
    account_id: "acct-1",
    payload: { ...validPayload, in_reply_to: "<parent@example.com>" },
  });
  assert.notEqual(plain, reply);
});

test("computeOutboundRequestHash ignores from_name/to_name ordering noise", async () => {
  const withName = await computeOutboundRequestHash({
    account_id: "acct-1",
    payload: { ...validPayload, from_name: "Me" },
  });
  const withoutName = await computeOutboundRequestHash({
    account_id: "acct-1",
    payload: { ...validPayload, from_name: undefined },
  });
  assert.notEqual(withName, withoutName);
});

test("providerForAccountSource maps known sources and rejects unknown", () => {
  assert.equal(providerForAccountSource("imap_qq"), "imap_qq");
  assert.equal(providerForAccountSource("IMAP_163"), "imap_163");
  assert.equal(providerForAccountSource("graph_outlook"), "graph_outlook");
  assert.equal(providerForAccountSource("smtp"), null);
  assert.equal(providerForAccountSource(undefined), null);
  assert.equal(providerForAccountSource(7), null);
});
