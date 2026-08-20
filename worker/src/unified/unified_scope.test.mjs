import assert from "node:assert/strict";
import test from "node:test";
import { canAccess, canAccessRow, scopeQuery } from "./api_keys.ts";
import { buildEmailFilters } from "./unified_query.ts";

const roQq = { role: "readonly", allowed_sources: JSON.stringify("imap_qq"), allowed_accounts: JSON.stringify("qq-main") };
const admin = { role: "admin", allowed_sources: null, allowed_accounts: null };

test("readonly canAccess: row from other account is forbidden", () => {
  assert.equal(canAccess(roQq, "GET", "imap_qq", "qq-main"), true);
  assert.equal(canAccess(roQq, "GET", "imap_qq", "163-main"), false); // 账号越权
  assert.equal(canAccess(roQq, "GET", "imap_163", "qq-main"), false); // 来源越权
});

test("canAccessRow: row-level deny on undefined/missing values (C1 Important-2)", () => {
  // 行级鉴权专用入口：缺失(undefined)/空/NULL 的行值一律拒绝——
  // canAccess 对 undefined 放行（请求层交给 scopeQuery），但行级调用
  // 没有 scopeQuery 注入，若 DB NULL 被误转成 undefined 就会静默重开 C1。
  assert.equal(canAccessRow(roQq, "imap_qq", "qq-main"), true);      // 命中白名单
  assert.equal(canAccessRow(roQq, "imap_qq", "163-main"), false);    // 账号越权
  assert.equal(canAccessRow(roQq, "imap_163", "qq-main"), false);    // 来源越权
  // 行级缺失 → 拒绝（对比 canAccess 的 undefined 放行）
  assert.equal(canAccessRow(roQq, undefined, undefined), false);
  assert.equal(canAccessRow(roQq, "imap_qq", undefined), false);
  assert.equal(canAccessRow(roQq, undefined, "qq-main"), false);
  assert.equal(canAccessRow(roQq, null, null), false);                // 行级 NULL
  assert.equal(canAccessRow(roQq, "", "qq-main"), false);           // 空串
  // admin 行级总是可读
  assert.equal(canAccessRow(admin, undefined, undefined), true);
  // 无白名单（未配置作用域）的 key：任意行可读（维持原语义）
  const roOpen = { role: "readonly", allowed_sources: null, allowed_accounts: null };
  assert.equal(canAccessRow(roOpen, "whatever", "any"), true);
});

test("C1: scoped key cannot read rows with NULL account/source (fail-closed)", () => {
  // 行级校验（getEmail 场景）：NULL account_id / source 的行必须拒绝，不能早退 true
  assert.equal(canAccess(roQq, "GET", "imap_qq", null), false);
  assert.equal(canAccess(roQq, "GET", null, "qq-main"), false);
  assert.equal(canAccess(roQq, "GET", null, null), false);
  // 请求级校验（middleware 场景）：未携带过滤参数 → 放行，由 scopeQuery 注入白名单限定范围
  assert.equal(canAccess(roQq, "GET", undefined, undefined), true);
  // 白名单为 null（未配置作用域）时，任意来源可读——维持原语义
  const roOpen = { role: "readonly", allowed_sources: null, allowed_accounts: null };
  assert.equal(canAccess(roOpen, "GET", "whatever", "qq-main"), true);
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