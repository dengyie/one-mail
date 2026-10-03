import assert from "node:assert/strict";
import test from "node:test";

import {
  getDomainResendToken,
  resendTokenEnvKey,
  resolveSendMailChannel,
} from "./send_mail_channel.ts";

test("resendTokenEnvKey uppercases dots to underscores", () => {
  assert.equal(resendTokenEnvKey("mangoqwq.com"), "RESEND_TOKEN_MANGOQWQ_COM");
  assert.equal(resendTokenEnvKey("otp.mangoqwq.com"), "RESEND_TOKEN_OTP_MANGOQWQ_COM");
  assert.equal(resendTokenEnvKey("verify.mangoqwq.com"), "RESEND_TOKEN_VERIFY_MANGOQWQ_COM");
  assert.equal(resendTokenEnvKey("mangoqwq.cc.cd"), "RESEND_TOKEN_MANGOQWQ_CC_CD");
  assert.equal(resendTokenEnvKey("mangoq.ccwu.cc"), "RESEND_TOKEN_MANGOQ_CCWU_CC");
});

test("getDomainResendToken reads only the matching domain secret", () => {
  const env = {
    RESEND_TOKEN: "global-token",
    RESEND_TOKEN_MANGOQWQ_COM: "resend-com",
    RESEND_TOKEN_OTP_MANGOQWQ_COM: "resend-otp",
    RESEND_TOKEN_VERIFY_MANGOQWQ_COM: "resend-verify",
  };
  assert.equal(getDomainResendToken(env, "mangoqwq.com"), "resend-com");
  assert.equal(getDomainResendToken(env, "otp.mangoqwq.com"), "resend-otp");
  assert.equal(getDomainResendToken(env, "verify.mangoqwq.com"), "resend-verify");
  assert.equal(getDomainResendToken(env, "mangoqwq.cc.cd"), null);
});

test("domain Resend beats SMTP and global Resend", () => {
  const channel = resolveSendMailChannel({
    domainResendToken: "resend-com",
    globalResendToken: "global-token",
    smtpConfig: { host: "smtp-relay.brevo.com" },
    sendMailBindingEnabled: true,
  });
  assert.deepEqual(channel, {
    kind: "resend",
    token: "resend-com",
    source: "domain",
  });
});

test("domain SMTP beats global Resend so one Worker can split providers", () => {
  const smtp = { host: "mail.smtp2go.com", port: 2525 };
  const channel = resolveSendMailChannel({
    domainResendToken: "",
    globalResendToken: "global-token",
    smtpConfig: smtp,
    sendMailBindingEnabled: true,
  });
  assert.deepEqual(channel, { kind: "smtp", options: smtp });
});

test("global Resend is fallback when domain has neither Resend nor SMTP", () => {
  const channel = resolveSendMailChannel({
    domainResendToken: "   ",
    globalResendToken: "global-token",
    smtpConfig: null,
    sendMailBindingEnabled: true,
  });
  assert.deepEqual(channel, {
    kind: "resend",
    token: "global-token",
    source: "global",
  });
});

test("SEND_MAIL binding is last among paid channels", () => {
  const channel = resolveSendMailChannel({
    domainResendToken: null,
    globalResendToken: null,
    smtpConfig: null,
    sendMailBindingEnabled: true,
  });
  assert.deepEqual(channel, { kind: "binding" });
});

test("none when no provider is configured", () => {
  const channel = resolveSendMailChannel({
    sendMailBindingEnabled: false,
  });
  assert.deepEqual(channel, { kind: "none" });
});

test("otp subdomain Resend does not steal the apex SMTP channel", () => {
  const env = {
    RESEND_TOKEN_OTP_MANGOQWQ_COM: "resend-otp",
  };
  assert.equal(getDomainResendToken(env, "mangoqwq.com"), null);
  const smtp = { host: "smtp-relay.brevo.com", port: 587 };
  const channel = resolveSendMailChannel({
    domainResendToken: getDomainResendToken(env, "mangoqwq.cc.cd"),
    globalResendToken: null,
    smtpConfig: smtp,
    sendMailBindingEnabled: true,
  });
  assert.deepEqual(channel, { kind: "smtp", options: smtp });
});
