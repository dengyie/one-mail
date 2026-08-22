import assert from "node:assert/strict";
import test from "node:test";
import { buildEmailFilters } from "./unified_query.ts";

test("buildEmailFilters with no params returns 1=1", () => {
  const f = buildEmailFilters({});
  assert.equal(f.where, "1=1");
  assert.deepEqual(f.params, []);
});

test("buildEmailFilters combines source/unread/q", () => {
  const f = buildEmailFilters({ source: "imap_qq", unread: "1", q: "验证码" });
  assert.equal(f.where, "1=1 AND source = ? AND is_read = 0 AND (subject LIKE ? OR from_addr LIKE ? OR text_body LIKE ?)");
  assert.deepEqual(f.params, ["imap_qq", "%验证码%", "%验证码%", "%验证码%"]);
});

test("buildEmailFilters account_id + date range", () => {
  const f = buildEmailFilters({ account_id: "a@qq.com", since: "100", until: "200" });
  assert.equal(f.where, "1=1 AND account_id = ? AND received_at >= ? AND received_at <= ?");
  assert.deepEqual(f.params, ["a@qq.com", 100, 200]);
});

test("buildEmailFilters comma-separated source becomes IN clause (M4 multi-whitelist)", () => {
  const f = buildEmailFilters({ source: "imap_qq,imap_163" });
  assert.equal(f.where, "1=1 AND source IN (?,?)");
  assert.deepEqual(f.params, ["imap_qq", "imap_163"]);
});

test("buildEmailFilters scopes user mail by bound recipient addresses", () => {
  const f = buildEmailFilters({ to_addr: "alice@example.com,bob@example.com", unread: "1" });
  assert.equal(f.where, "1=1 AND to_addr IN (?,?) AND is_read = 0");
  assert.deepEqual(f.params, ["alice@example.com", "bob@example.com"]);
});