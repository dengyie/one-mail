import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSendboxListFilter,
  buildSendboxRaw,
  decorateSendboxRow,
  parseSendboxChannelParam,
  parseSendboxSourcesParam,
  persistChannelFromDispatch,
  resolveClientSource,
  resolveSendMailSource,
  sanitizeSendboxQ,
} from "./sendbox_source.ts";

test("web header on /api/send_mail maps to user_ui", () => {
  assert.equal(resolveClientSource("/api/send_mail", "web"), "user_ui");
  assert.equal(resolveClientSource("/api/send_mail", "WEB"), "user_ui");
});

test("smtp-proxy header maps to smtp_proxy even on external path", () => {
  assert.equal(
    resolveClientSource("/external/api/send_mail", "smtp-proxy"),
    "smtp_proxy",
  );
});

test("missing header defaults by path", () => {
  assert.equal(resolveClientSource("/api/send_mail", null), "user_api");
  assert.equal(resolveClientSource("/api/send_mail", ""), "user_api");
  assert.equal(resolveClientSource("/external/api/send_mail", undefined), "external_api");
});

test("forged or unknown client headers are ignored", () => {
  assert.equal(resolveClientSource("/api/send_mail", "admin"), "user_api");
  assert.equal(resolveClientSource("/api/send_mail", "curl"), "user_api");
  assert.equal(resolveClientSource("/external/api/send_mail", "web-forged"), "external_api");
});

test("explicit admin / system_otp / admin_binding win over headers", () => {
  assert.equal(resolveSendMailSource({
    explicit: "admin",
    path: "/api/send_mail",
    header: "web",
  }), "admin");
  assert.equal(resolveSendMailSource({
    explicit: "system_otp",
    header: "web",
  }), "system_otp");
  assert.equal(resolveSendMailSource({
    explicit: "admin_binding",
  }), "admin_binding");
  assert.equal(resolveSendMailSource({
    explicit: "not-a-source",
    path: "/api/send_mail",
    header: "web",
  }), "user_ui");
});

test("old sendbox rows without source decorate as unknown", () => {
  const decorated = decorateSendboxRow({
    id: 1,
    address: "a@example.com",
    raw: JSON.stringify({ version: "v2", to_mail: "b@x.com", subject: "hi", content: "c" }),
  });
  assert.equal(decorated.source, "unknown");
  assert.equal(decorated.channel, null);
  assert.equal(decorated.to_mail, "b@x.com");
  assert.equal(decorated.subject, "hi");
  assert.equal(decorated.provider_message_id, null);
});

test("decorate prefers SQL columns over raw keys", () => {
  const decorated = decorateSendboxRow({
    source: "user_ui",
    channel: "resend",
    provider_message_id: "re_col",
    raw: JSON.stringify({ source: "admin", channel: "smtp", to_mail: "raw@x.com", subject: "raw", provider_message_id: "re_raw" }),
    to_mail: "col@x.com",
    subject: "col",
  });
  assert.equal(decorated.source, "user_ui");
  assert.equal(decorated.channel, "resend");
  assert.equal(decorated.to_mail, "col@x.com");
  assert.equal(decorated.subject, "col");
  assert.equal(decorated.provider_message_id, "re_col");
});

test("decorate falls back to raw provider_message_id", () => {
  const decorated = decorateSendboxRow({
    raw: JSON.stringify({ provider_message_id: "re_raw", to_mail: "b@x.com", subject: "hi" }),
  });
  assert.equal(decorated.provider_message_id, "re_raw");
});

test("illegal q fail-closes to null instead of 400", () => {
  assert.equal(sanitizeSendboxQ("%"), null);
  assert.equal(sanitizeSendboxQ("a_b"), null);
  assert.equal(sanitizeSendboxQ("a\\b"), null);
  assert.equal(sanitizeSendboxQ("ab\n"), null);
  assert.equal(sanitizeSendboxQ("x".repeat(81)), null);
  assert.equal(sanitizeSendboxQ(""), undefined);
  assert.equal(sanitizeSendboxQ(undefined), undefined);
  assert.equal(sanitizeSendboxQ("验证码"), "验证码");
  assert.equal(sanitizeSendboxQ("hello subject"), "hello subject");
});

test("source whitelist drops illegal tokens; all-illegal is empty list", () => {
  assert.deepEqual(parseSendboxSourcesParam("user_ui,admin"), ["user_ui", "admin"]);
  assert.deepEqual(parseSendboxSourcesParam("user_ui,nope,unknown"), ["user_ui", "unknown"]);
  assert.deepEqual(parseSendboxSourcesParam("nope,also-bad"), []);
  assert.equal(parseSendboxSourcesParam(""), null);
  assert.equal(parseSendboxSourcesParam(undefined), null);
});

test("channel whitelist fail-closes illegal tokens and binds a legal channel", () => {
  assert.equal(parseSendboxChannelParam(""), undefined);
  assert.equal(parseSendboxChannelParam(undefined), undefined);
  assert.equal(parseSendboxChannelParam("smtp-forged"), null);
  assert.equal(parseSendboxChannelParam("resend"), "resend");
  assert.equal(buildSendboxListFilter({ channel: "nope" }).empty, true);
  const ok = buildSendboxListFilter({ address: "a@x.com", source: "user_ui", channel: "resend" });
  assert.equal(ok.empty, false);
  assert.match(ok.where, /channel = \?/);
  assert.deepEqual(ok.params, ["a@x.com", "user_ui", "resend"]);
});

test("list filter fail-closes on illegal q or empty source whitelist", () => {
  assert.equal(buildSendboxListFilter({ q: "%" }).empty, true);
  assert.equal(buildSendboxListFilter({ source: "nope" }).empty, true);
  const ok = buildSendboxListFilter({ address: "a@x.com", source: "user_ui", q: "hi" });
  assert.equal(ok.empty, false);
  assert.match(ok.where, /address = \?/);
  assert.match(ok.where, /source IN \(\?\)/);
  assert.match(ok.where, /json_extract\(raw, '\$\.subject'\) LIKE \?/);
  assert.deepEqual(ok.params, ["a@x.com", "user_ui", "%hi%", "%hi%"]);
});

test("unknown source matches NULL or the unknown token", () => {
  const filter = buildSendboxListFilter({ source: "unknown,user_ui" });
  assert.equal(filter.empty, false);
  assert.match(filter.where, /source IN \(\?\)/);
  assert.match(filter.where, /source IS NULL OR source = 'unknown'/);
  assert.deepEqual(filter.params, ["user_ui"]);
});

test("buildSendboxRaw stays v2 and keeps to_mail/content/is_html", () => {
  const raw = buildSendboxRaw({
    reqJson: {
      from_name: "Me",
      to_mail: "b@x.com",
      content: "<p>hi</p>",
      is_html: true,
      subject: "s",
    },
    geoData: { ip: "1.1.1.1" },
    source: "user_ui",
    channel: "resend",
    channel_source: "domain",
    provider_message_id: "re_123",
    reservation_id: "rsv_1",
    status: "sent",
  });
  assert.equal(raw.version, "v2");
  assert.equal(raw.to_mail, "b@x.com");
  assert.equal(raw.content, "<p>hi</p>");
  assert.equal(raw.is_html, true);
  assert.equal(raw.source, "user_ui");
  assert.equal(raw.channel, "resend");
  assert.equal(raw.channel_source, "domain");
  assert.equal(raw.provider_message_id, "re_123");
  assert.equal(raw.reservation_id, "rsv_1");
  assert.equal(raw.status, "sent");
});

test("persistChannelFromDispatch maps verified binding and resend source", () => {
  assert.deepEqual(persistChannelFromDispatch({
    sendByVerifiedAddressList: true,
    channel: { kind: "resend", source: "domain" },
  }), { channel: "verified_binding" });
  assert.deepEqual(persistChannelFromDispatch({
    sendByVerifiedAddressList: false,
    channel: { kind: "resend", source: "global" },
  }), { channel: "resend", channel_source: "global" });
  assert.deepEqual(persistChannelFromDispatch({
    sendByVerifiedAddressList: false,
    channel: { kind: "smtp" },
  }), { channel: "smtp" });
});
