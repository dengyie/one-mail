import assert from "node:assert/strict";
import test from "node:test";
import { canAccess, scopeQuery } from "./api_keys.ts";
import { buildEmailFilters } from "./unified_query.ts";

const roQq = { role: "readonly", allowed_sources: JSON.stringify("imap_qq"), allowed_accounts: JSON.stringify("qq-main") };

test("readonly canAccess: row from other account is forbidden", () => {
  assert.equal(canAccess(roQq, "GET", "imap_qq", "qq-main"), true);
  assert.equal(canAccess(roQq, "GET", "imap_qq", "163-main"), false); // 账号越权
  assert.equal(canAccess(roQq, "GET", "imap_163", "qq-main"), false); // 来源越权
});

test("scopeQuery injects whitelist so verifcodes/count share the same WHERE guard", () => {
  const scoped = scopeQuery(roQq, {});
  assert.equal(scoped.source, "imap_qq");
  assert.equal(scoped.account_id, "qq-main");
  // 与 buildEmailFilters 组合后，WHERE 必须带上 source+account 约束
  const f = buildEmailFilters(scoped);
  assert.ok(f.where.includes("source = ?"));
  assert.ok(f.where.includes("account_id = ?"));
});

test("unread=0 filters to read messages", () => {
  const f = buildEmailFilters({ unread: "0" });
  assert.equal(f.where, "1=1 AND is_read = 1");
  const f1 = buildEmailFilters({ unread: "1" });
  assert.equal(f1.where, "1=1 AND is_read = 0");
  const fnone = buildEmailFilters({});
  assert.equal(fnone.where, "1=1");
});