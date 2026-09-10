import assert from "node:assert/strict";
import test from "node:test";

import {
  isSafeCustomMailHost,
  validateMailAccountCreateTarget,
  validateMailTargetPolicy,
} from "../user_api/mail_target_policy.ts";

test("preset mail sources are bound to their provider endpoints", () => {
  assert.equal(validateMailTargetPolicy({
    source: "imap_gmail",
    protocol: "auto",
    host: "imap.gmail.com",
    port: 993,
    pop3Host: "pop.gmail.com",
    pop3Port: 995,
  }), true);

  assert.equal(validateMailTargetPolicy({
    source: "imap_gmail",
    protocol: "auto",
    host: "127.0.0.1",
    port: 993,
    pop3Host: "pop.gmail.com",
    pop3Port: 995,
  }), false);

  assert.equal(validateMailTargetPolicy({
    source: "imap_outlook",
    protocol: "pop3",
    host: "outlook.office365.com",
    port: 993,
    pop3Host: "127.0.0.1",
    pop3Port: 995,
  }), false);

  assert.equal(validateMailTargetPolicy({
    source: "imap_qq",
    protocol: "imap",
    host: "imap.qq.com",
    port: 143,
    pop3Host: null,
    pop3Port: null,
  }), false);
});

test("custom mail hosts reject obvious local and non-global targets", () => {
  for (const host of [
    "localhost",
    "mail.localhost",
    "router.local",
    "service.internal",
    "nas.lan",
    "127.0.0.1",
    "127.1",
    "2130706433",
    "0177.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "::1",
    "::ffff:7f00:1",
    "fd00::1",
    "fe80::1",
    "2001:db8::1",
    "127.0.0.1.nip.io",
    "0x7f.0.0.1",
  ]) {
    assert.equal(isSafeCustomMailHost(host), false, host);
  }

  assert.equal(isSafeCustomMailHost("imap.example.com"), true);
  assert.equal(isSafeCustomMailHost("8.8.8.8"), true);
  assert.equal(isSafeCustomMailHost("2606:4700:4700::1111"), true);
});

test("custom source validates both IMAP and optional POP3 hosts", () => {
  assert.equal(validateMailTargetPolicy({
    source: "imap_custom",
    protocol: "auto",
    host: "imap.example.com",
    port: 993,
    pop3Host: "pop.example.com",
    pop3Port: 995,
  }), true);

  assert.equal(validateMailTargetPolicy({
    source: "imap_custom",
    protocol: "auto",
    host: "imap.example.com",
    port: 993,
    pop3Host: "169.254.169.254",
    pop3Port: 995,
  }), false);
});

test("raw create-account gate preserves valid presets and rejects endpoint tampering", () => {
  assert.equal(validateMailAccountCreateTarget({
    source: "imap_gmail",
    protocol: "auto",
    host: "imap.gmail.com",
    port: 993,
    pop3_host: "pop.gmail.com",
    pop3_port: 995,
  }), true);

  assert.equal(validateMailAccountCreateTarget({
    source: "imap_gmail",
    protocol: "auto",
    host: "169.254.169.254",
    port: 993,
    pop3_host: "pop.gmail.com",
    pop3_port: 995,
  }), false);

  assert.equal(validateMailAccountCreateTarget({
    source: "imap_custom",
    protocol: "pop3",
    host: "imap.example.com",
    port: 993,
    pop3_host: "127.0.0.1",
    pop3_port: 995,
  }), false);
});
