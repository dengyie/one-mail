import assert from "node:assert/strict";
import test from "node:test";
import { isSafeWebhookUrl } from "./webhook_url.ts";

// I7d 回归：webhook URL SSRF 静态校验。拒绝私有/回环/链路本地/元数据/非法 scheme，
// 放行公网 HTTP(S)。

test("rejects private / loopback IPs", () => {
  assert.equal(isSafeWebhookUrl("http://127.0.0.1"), false);
  assert.equal(isSafeWebhookUrl("http://10.0.0.1"), false);
  assert.equal(isSafeWebhookUrl("http://192.168.1.1"), false);
  assert.equal(isSafeWebhookUrl("http://172.16.0.1"), false);
  assert.equal(isSafeWebhookUrl("http://172.31.255.255"), false);
  assert.equal(isSafeWebhookUrl("http://0.0.0.0"), false);
  assert.equal(isSafeWebhookUrl("http://169.254.169.254"), false);
});

test("rejects localhost / .local hostnames", () => {
  assert.equal(isSafeWebhookUrl("http://localhost"), false);
  assert.equal(isSafeWebhookUrl("http://localhost:8080/x"), false);
  assert.equal(isSafeWebhookUrl("http://foo.local"), false);
  assert.equal(isSafeWebhookUrl("http://bar.localhost"), false);
});

test("rejects IPv6 loopback / link-local", () => {
  assert.equal(isSafeWebhookUrl("http://[::1]"), false);
  assert.equal(isSafeWebhookUrl("http://[::]"), false);
});

test("rejects IPv4-mapped IPv6 pointing at private IPv4 (I7d)", () => {
  assert.equal(isSafeWebhookUrl("http://[::ffff:127.0.0.1]"), false);
  assert.equal(isSafeWebhookUrl("http://[::ffff:169.254.169.254]"), false);
  assert.equal(isSafeWebhookUrl("http://[::ffff:192.168.1.1]"), false);
  assert.equal(isSafeWebhookUrl("http://[::ffff:10.0.0.1]"), false);
  assert.equal(isSafeWebhookUrl("http://[::ffff:0.0.0.0]"), false);
});

test("rejects deprecated IPv4-compatible IPv6 pointing at private IPv4 (I7d)", () => {
  assert.equal(isSafeWebhookUrl("http://[::127.0.0.1]"), false);
  assert.equal(isSafeWebhookUrl("http://[::10.0.0.1]"), false);
});

test("rejects alternate IP encodings", () => {
  assert.equal(isSafeWebhookUrl("http://2130706433"), false);        // 127.0.0.1 十进制整数
  assert.equal(isSafeWebhookUrl("http://0x7f.0.0.1"), false);        // 十六进制段
  assert.equal(isSafeWebhookUrl("http://0x7f000001"), false);        // 十六进制整数形式
  assert.equal(isSafeWebhookUrl("http://0177.0.0.1"), false);        // 前置零段（Number 解析收敛为 127.x）
});

test("rejects rebinding-helper hostnames containing a private dotted IP", () => {
  assert.equal(isSafeWebhookUrl("http://127.0.0.1.nip.io"), false);
  assert.equal(isSafeWebhookUrl("http://169.254.169.254.sslip.io"), false);
});

test("rejects non-http(s) schemes", () => {
  assert.equal(isSafeWebhookUrl("ftp://example.com"), false);
  assert.equal(isSafeWebhookUrl("file:///etc/passwd"), false);
  assert.equal(isSafeWebhookUrl("gopher://127.0.0.1:70/a"), false);
});

test("rejects malformed URLs", () => {
  assert.equal(isSafeWebhookUrl("not-a-url"), false);
  assert.equal(isSafeWebhookUrl(""), false);
  assert.equal(isSafeWebhookUrl("http://"), false);
});

test("allows public hosts", () => {
  assert.equal(isSafeWebhookUrl("https://hooks.slack.com/services/x"), true);
  assert.equal(isSafeWebhookUrl("https://8.8.8.8/webhook"), true);
  assert.equal(isSafeWebhookUrl("https://example.com/x"), true);
  assert.equal(isSafeWebhookUrl("http://93.184.216.34/"), true);
});

test("allows public IPv6 (not mapped, not private) (I7d)", () => {
  assert.equal(isSafeWebhookUrl("https://[2606:4700:4700::1111]"), true);
  // IPv4-mapped IPv6 wrapping a PUBLIC IPv4 must still be allowed
  assert.equal(isSafeWebhookUrl("http://[::ffff:8.8.8.8]"), true);
});