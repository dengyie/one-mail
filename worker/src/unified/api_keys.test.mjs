import assert from "node:assert/strict";
import test from "node:test";
import { hashKey, canAccess, scopeQuery } from "./api_keys.ts";

test("hashKey is sha256 hex", async () => {
  const h = await hashKey("secret");
  assert.match(h, /^[0-9a-f]{64}$/);
});

const admin = { role: "admin", allowed_sources: null, allowed_accounts: null };
const roAll = { role: "readonly", allowed_sources: null, allowed_accounts: null };
const roQq = { role: "readonly", allowed_sources: '["imap_qq"]', allowed_accounts: '["qq-main"]' };

test("admin can do anything", () => {
  assert.equal(canAccess(admin, "GET"), true);
  assert.equal(canAccess(admin, "POST"), true);
  assert.equal(canAccess(admin, "DELETE"), true);
});

test("readonly is GET-only", () => {
  assert.equal(canAccess(roAll, "GET"), true);
  assert.equal(canAccess(roAll, "POST"), false);
  assert.equal(canAccess(roAll, "DELETE"), false);
});

test("readonly source whitelist enforced", () => {
  assert.equal(canAccess(roQq, "GET", "imap_qq", "qq-main"), true);
  assert.equal(canAccess(roQq, "GET", "imap_gmail", "qq-main"), false);
  assert.equal(canAccess(roQq, "GET", "imap_qq", "gmail-1"), false);
  // 不带过滤的 GET：允许（由 scopeQuery 注入白名单）
  assert.equal(canAccess(roQq, "GET"), true);
});

test("readonly multi-value query: every value must be in whitelist", () => {
  assert.equal(canAccess(roQq, "GET", "imap_qq,imap_qq"), true);       // 全部在白名单
  assert.equal(canAccess(roQq, "GET", "imap_qq,imap_gmail"), false);   // 含越权来源
});

test("scopeQuery injects multi-value whitelist as comma-separated (feeds IN clause)", () => {
  const scoped = scopeQuery({ role: "readonly", allowed_sources: '["imap_qq","imap_163"]', allowed_accounts: null }, {});
  assert.equal(scoped.source, "imap_qq,imap_163");
  // 用户显式传了 source 则不覆盖（由 canAccess 负责校验越权）
  const kept = scopeQuery({ role: "readonly", allowed_sources: '["imap_qq"]', allowed_accounts: null }, { source: "imap_qq" });
  assert.equal(kept.source, "imap_qq");
});