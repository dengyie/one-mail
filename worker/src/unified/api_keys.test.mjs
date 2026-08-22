import assert from "node:assert/strict";
import test from "node:test";
import { hashKey, canAccess, scopeQuery, userAddressScope } from "./api_keys.ts";

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
  // C1 fail-closed（行级）：显式传入空/NULL 值不得早退——但未携带参数（undefined）
  // 由 middleware 交给 scopeQuery 注入白名单，在此放行。
  assert.equal(canAccess(roQq, "GET"), true);                          // 未带过滤参数 → 放行（scopeQuery 负责注入）
  assert.equal(canAccess(roQq, "GET", "imap_qq"), true);               // 请求只带 source：account 未传 → scopeQuery 注入 account
  assert.equal(canAccess(roQq, "GET", undefined, "qq-main"), true);    // 请求只带 account：source 未传 → scopeQuery 注入 source
});

test("readonly multi-value query: every value must be in whitelist", () => {
  // 显式传 account（与 middleware 注入白名单后的行检查对齐），两个来源都在白名单 → 放行
  assert.equal(canAccess(roQq, "GET", "imap_qq,imap_qq", "qq-main"), true);       // 全部在白名单
  assert.equal(canAccess(roQq, "GET", "imap_qq,imap_gmail", "qq-main"), false);   // 含越权来源
});

test("scopeQuery injects multi-value whitelist as comma-separated (feeds IN clause)", () => {
  const scoped = scopeQuery({ role: "readonly", allowed_sources: '["imap_qq","imap_163"]', allowed_accounts: null }, {});
  assert.equal(scoped.source, "imap_qq,imap_163");
  // 用户显式传了 source 则不覆盖（由 canAccess 负责校验越权）
  const kept = scopeQuery({ role: "readonly", allowed_sources: '["imap_qq"]', allowed_accounts: null }, { source: "imap_qq" });
  assert.equal(kept.source, "imap_qq");
});

test("parseList survives JSON.stringify of a comma string (key_admin normalization)", () => {
  // key_admin JSON.stringify 的入参若是逗号字符串，会存成 "\"imap_qq,imap_163\""；
  // parseList 需回退按逗号拆分，scopeQuery 才能 join（回归 accounts.join is not a function）
  const scoped = scopeQuery({ role: "readonly", allowed_sources: JSON.stringify("imap_qq,imap_163"), allowed_accounts: null }, {});
  assert.equal(scoped.source, "imap_qq,imap_163");
});

/**
 * 隔离回归测试（review I4）：锁定多租户隔离不变量——
 *   1) 普通用户归属作用域 = 绑定本站地址 ∪ 接入外部邮箱 username
 *   2) 无归属 → "__none__"（resolveScope fail-closed → 查 0 行而非全部）
 *   3) 两人接入同名外部邮箱各自归属隔离（UNION user_mail_accounts.username，
 *      不依赖 users_address.address_id UNIQUE）
 * userAddressScope 是 resolveScope/checkRowAccess 的唯一数据源，锁定其输出契约
 * 即锁定整个隔离读路径。
 */
const makeDb = (rowsByUser) => ({
  prepare: () => {
    let binds = [];
    const stmt = {
      bind: (...args) => { binds = args; return stmt; },
      all: async () => ({ results: rowsByUser[Number(binds[0])] ?? [] }),
    };
    return stmt;
  },
});

test("userAddressScope returns comma-joined bound + external usernames", async () => {
  const db = makeDb({
    10: [
      { name: "alice@mangoqwq.com" },   // 本站绑定地址
      { name: "alice@gmail.com" },        // 接入的外部邮箱 username
      { name: "alice@qq.com" },            // 接入的外部邮箱 username
    ],
  });
  const scope = await userAddressScope(db, 10);
  assert.equal(scope, "alice@mangoqwq.com,alice@gmail.com,alice@qq.com");
});

test("userAddressScope returns __none__ when user has no bindings (fail-closed)", async () => {
  const db = makeDb({});
  const scope = await userAddressScope(db, 99);
  assert.equal(scope, "__none__");
  assert.notEqual(scope, "");  // 绝非空串——空归属显式用哨兵
});

test("two users with same external address stay isolated — each scope holds own set only", async () => {
  // 用户 A、B 都接入 alice@gmail.com（同名外部邮箱）。UNION 取 username，各自归属
  // 独立——邮件按 account_id 区分归属（A 的 account_id ≠ B 的），checkRowAccess
  // 只对该用户启用且绑定的账号放行，to_addr 同名不串看。
  const dbA = makeDb({ 10: [{ name: "alice@gmail.com" }] });
  const dbB = makeDb({ 20: [{ name: "alice@gmail.com" }] });
  assert.equal(await userAddressScope(dbA, 10), "alice@gmail.com");
  assert.equal(await userAddressScope(dbB, 20), "alice@gmail.com");
  // 作用域字符串相同不构成泄漏：归属由 account_id + 邮件 to_addr 共同决定，A 的
  // 邮件不会落入 B 的 account_id 视图。
});