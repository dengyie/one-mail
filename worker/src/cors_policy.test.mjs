import assert from "node:assert/strict";
import test from "node:test";
import { resolveCorsOrigin } from "./cors_policy.ts";

test("allows exact match and valid subdomains of official domains", () => {
  assert.equal(resolveCorsOrigin("https://inbox.mangoqwq.com"), "https://inbox.mangoqwq.com");
  assert.equal(resolveCorsOrigin("https://mail.mangoqwq.com"), "https://mail.mangoqwq.com");
  assert.equal(resolveCorsOrigin("https://app.mangoqwq.com"), "https://app.mangoqwq.com");
  assert.equal(resolveCorsOrigin("https://mail-api.mangoqwq.cc.cd"), "https://mail-api.mangoqwq.cc.cd");
});

test("allows local development servers and custom FRONTEND_URL", () => {
  assert.equal(resolveCorsOrigin("http://localhost:5173"), "http://localhost:5173");
  assert.equal(resolveCorsOrigin("http://127.0.0.1:5173"), "http://127.0.0.1:5173");
  assert.equal(resolveCorsOrigin("https://preview.pages.dev", "https://preview.pages.dev, https://prod.pages.dev"), "https://preview.pages.dev");
});

test("strictly rejects suffix hijacking attempts", () => {
  assert.equal(resolveCorsOrigin("https://evil-mangoqwq.com"), "");
  assert.equal(resolveCorsOrigin("https://attacker-mangoqwq.cc.cd"), "");
  assert.equal(resolveCorsOrigin("https://fakemangoqwq.com"), "");
  assert.equal(resolveCorsOrigin("https://evil.com"), "");
});
