import assert from "node:assert/strict";
import test from "node:test";

import {
  OUTBOUND_PROVIDERS,
  OUTBOUND_STATUSES,
  computeOutboundRequestHash,
  isOutboundProvider,
  isOutboundStatus,
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
