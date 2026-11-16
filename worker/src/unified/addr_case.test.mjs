import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { normalizeToAddr, normalizeRawMailAddress, TO_ADDR_NOCASE } from "./addr_case.ts";
import { buildVerifAddrClause } from "./verifcode.ts";
import { buildEmailFilters } from "./unified_query.ts";
import { boundedEmailFilter } from "./unified_sql.ts";
import { toEmailInsertParams } from "./ingest.ts";
import { archivalValues, ARCHIVE_EMAIL_COLUMNS } from "./archival_ingest.ts";
import { buildUnifiedEmailRow } from "./unified_store.ts";

/**
 * to_addr 的大小写语义回归。
 *
 * 事故根因：emails.to_addr 入库保留原始大小写（KevinWalters5892@outlook.com），
 * 而查询侧把入参 lower() 后做二进制全等，SQLite 的 TEXT `=` 区分大小写，
 * 于是「邮件在库里却查不出来」——取验证码永远返回空。
 *
 * 这里用 node:sqlite 复刻真实数据形态（混合大小写存量行 + 小写新行），
 * 锁死「读侧大小写不敏感 / 写侧归一成小写」两侧约定。
 */

// 事故当天的真实收件人形态：邮箱账号名带大小写。
const MIXED = "KevinWalters5892@outlook.com";
const MIXED_LOWER = "kevinwalters5892@outlook.com";

const makeDb = () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE emails (
    id TEXT PRIMARY KEY,
    source TEXT,
    account_id TEXT,
    from_addr TEXT,
    to_addr TEXT,
    subject TEXT,
    text_body TEXT,
    html_body TEXT,
    received_at INTEGER,
    is_read INTEGER
  )`);
  db.exec(`CREATE INDEX idx_emails_to_addr ON emails(to_addr)`);
  db.exec(`CREATE INDEX idx_emails_to_addr_nocase ON emails(to_addr COLLATE NOCASE, received_at DESC)`);
  db.exec(`CREATE TABLE address (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    source_meta TEXT
  )`);
  db.exec(`CREATE INDEX idx_address_name_nocase ON address(name COLLATE NOCASE)`);
  db.exec(`CREATE TABLE users_address (user_id INTEGER, address_id INTEGER)`);
  db.exec(`CREATE TABLE user_mail_accounts (id TEXT, user_id INTEGER)`);

  const insert = db.prepare(
    `INSERT INTO emails (id, source, account_id, from_addr, to_addr, subject, text_body, html_body, received_at, is_read)
     VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, 0)`,
  );
  // 存量混合大小写行（事故当天真实形态）
  insert.run("mail-mixed", "imap_outlook", "kw-outlook-main", "noreply@x.ai", MIXED,
    "Grok confirmation code: 078-843", "Grok confirmation code: 078843", 1000);
  // 归一化之后的新行
  insert.run("mail-lower", "imap_outlook", "kw-outlook-main", "noreply@x.ai", MIXED_LOWER,
    "Grok confirmation code: 111222", "Grok confirmation code: 111222", 2000);
  // 别名投递行：x.ai 发到 +alias，聚合器仍存基础地址
  insert.run("mail-other", "imap_gmail", "gmail-main", "noreply@x.ai", "someone.else@outlook.com",
    "hello", "hello", 3000);

  // 本站地址：名字带小写形态（本站建址一律小写），邮件侧可能是混合大小写。
  db.prepare(`INSERT INTO address (name, source_meta) VALUES (?, NULL)`).run(MIXED_LOWER);
  db.prepare(`INSERT INTO users_address (user_id, address_id) VALUES (7, 1)`).run();
  db.prepare(`INSERT INTO user_mail_accounts (id, user_id) VALUES ('kw-outlook-main', 7)`).run();
  return db;
};

const rowsFor = (db, where, params = []) =>
  db.prepare(`SELECT id, to_addr FROM emails WHERE ${where} ORDER BY id`).all(...params);

test("to_addr 精确匹配对混合大小写存量行可见（事故根因回归）", () => {
  const db = makeDb();
  const { clause, params } = buildVerifAddrClause(MIXED_LOWER);
  assert.equal(clause, ` AND ${TO_ADDR_NOCASE} = ?`);
  assert.deepEqual(params, [MIXED_LOWER]);

  const rows = rowsFor(db, `1=1${clause}`, params);
  assert.deepEqual(rows.map((r) => r.id), ["mail-lower", "mail-mixed"]);

  // 反证：二进制全等查不到——这正是事故当天的现象。
  const binary = rowsFor(db, "1=1 AND to_addr = ?", [MIXED_LOWER]);
  assert.deepEqual(binary.map((r) => r.id), ["mail-lower"]);
  db.close();
});

test("取码查询在混合大小写存量行上命中验证码正文", () => {
  const db = makeDb();
  const { clause, params } = buildVerifAddrClause(MIXED_LOWER);
  const rows = db.prepare(
    `SELECT subject, text_body FROM emails WHERE 1=1${clause} AND received_at >= ? ORDER BY received_at DESC`,
  ).all(...params, 0);
  const codes = rows
    .map((row) => String(row.text_body).match(/\b(\d{6})\b/)?.[1] ?? null)
    .filter(Boolean);
  assert.ok(codes.includes("078843"), "事故当天那封验证码邮件必须能被取到");
  db.close();
});

test("to_addr 域名后缀匹配同样大小写不敏感", () => {
  const db = makeDb();
  const { clause, params } = buildVerifAddrClause("@outlook.com");
  const rows = rowsFor(db, `1=1${clause}`, params);
  assert.deepEqual(rows.map((r) => r.id), ["mail-lower", "mail-mixed", "mail-other"]);
  db.close();
});

test("unified_query 的 to_addr 单值与多值过滤大小写不敏感", () => {
  const db = makeDb();

  const single = buildEmailFilters({ to_addr: MIXED_LOWER });
  assert.equal(single.where, `1=1 AND ${TO_ADDR_NOCASE} = ?`);
  assert.deepEqual(rowsFor(db, single.where, single.params).map((r) => r.id), ["mail-lower", "mail-mixed"]);

  const multi = buildEmailFilters({ to_addr: `${MIXED_LOWER},someone.else@outlook.com` });
  assert.equal(multi.where, `1=1 AND ${TO_ADDR_NOCASE} IN (?,?)`);
  assert.deepEqual(
    rowsFor(db, multi.where, multi.params).map((r) => r.id),
    ["mail-lower", "mail-mixed", "mail-other"],
  );

  // source / account_id 是稳定标识，绝不可折叠大小写
  const stable = buildEmailFilters({ source: "IMAP_OUTLOOK", account_id: "KW-Outlook-Main" });
  assert.equal(stable.where, "1=1 AND source = ? AND account_id = ?");
  assert.deepEqual(stable.params, ["IMAP_OUTLOOK", "KW-Outlook-Main"]);
  assert.deepEqual(rowsFor(db, stable.where, stable.params), []);
  db.close();
});

test("boundedEmailFilter 的 json_each 重写保留 COLLATE NOCASE", () => {
  const db = makeDb();
  const filter = buildEmailFilters({ to_addr: `${MIXED_LOWER},someone.else@outlook.com` });
  const bounded = boundedEmailFilter(filter);
  assert.equal(bounded.where, `1=1 AND ${TO_ADDR_NOCASE} IN (SELECT value FROM json_each(?))`);
  assert.equal(bounded.params.length, 1);
  assert.deepEqual(JSON.parse(bounded.params[0]), [MIXED_LOWER, "someone.else@outlook.com"]);

  const rows = rowsFor(db, bounded.where, bounded.params);
  assert.deepEqual(rows.map((r) => r.id), ["mail-lower", "mail-mixed", "mail-other"]);

  // 反证：把 COLLATE 丢掉就会退回二进制比较，混合大小写行消失。
  const lossy = bounded.where.replace(" COLLATE NOCASE", "");
  assert.deepEqual(rowsFor(db, lossy, bounded.params).map((r) => r.id), ["mail-lower", "mail-other"]);
  db.close();
});

test("NOCASE 索引命中精确匹配，避免全表扫描", () => {
  const db = makeDb();
  const { clause, params } = buildVerifAddrClause(MIXED_LOWER);
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM emails WHERE 1=1${clause}`).all(...params);
  const text = plan.map((row) => String(row.detail)).join(" ");
  assert.match(text, /idx_emails_to_addr_nocase/);
  assert.doesNotMatch(text, /SCAN emails\b/);
  db.close();
});

test("写入侧归一化：ingest / native store / archive 都落小写", () => {
  const params = toEmailInsertParams({
    source: "imap_outlook", account_id: "kw-outlook-main",
    from_addr: "noreply@x.ai", to_addr: MIXED,
  }, "mail-1", 1700000000000);
  // to_addr 是第 5 个字段（index 4）
  assert.equal(params[4], MIXED_LOWER);

  const row = buildUnifiedEmailRow(undefined, MIXED, "noreply@x.ai", 1700000000000, "mail-2");
  assert.equal(row.to_addr, MIXED_LOWER);
  // account_id 是租户边界/稳定标识，必须逐字节保留
  assert.equal(row.account_id, MIXED);

  const archive = archivalValues({
    ...Object.fromEntries(ARCHIVE_EMAIL_COLUMNS.map((c) => [c, null])),
    id: "mail-3", source: "imap_outlook", account_id: "kw-outlook-main",
    from_addr: "noreply@x.ai", to_addr: MIXED, received_at: 1700000000000,
  }, ARCHIVE_EMAIL_COLUMNS);
  assert.equal(archive[ARCHIVE_EMAIL_COLUMNS.indexOf("to_addr")], MIXED_LOWER);

  assert.equal(normalizeToAddr(`  ${MIXED}  `), MIXED_LOWER);
});

test("删除路径按大小写不敏感匹配，避免残留共享历史", () => {
  const db = makeDb();
  db.prepare("DELETE FROM emails WHERE to_addr COLLATE NOCASE = ?").run(MIXED_LOWER);
  assert.deepEqual(rowsFor(db, "1=1").map((r) => r.id), ["mail-other"]);

  db.prepare("INSERT INTO emails (id, source, account_id, from_addr, to_addr, subject, text_body, html_body, received_at, is_read)"
    + " VALUES ('mail-mixed-2', 'imap_outlook', 'kw-outlook-main', 'noreply@x.ai', ?, 's', 's', '', 4000, 0)").run(MIXED);
  db.prepare("DELETE FROM emails WHERE to_addr COLLATE NOCASE IN (SELECT name FROM address)").run();
  assert.deepEqual(rowsFor(db, "1=1").map((r) => r.id), ["mail-other"]);
  db.close();
});

test("租户归属：地址名小写时也能认领混合大小写的本站邮件", () => {
  const db = makeDb();
  // mail-mixed 改成本站投递，且 account_id 不归属该用户——
  // 只有「address.name 大小写不敏感」这条分支能认领它。
  db.prepare("UPDATE emails SET source = 'cf_routing', account_id = 'kw-outlook-other' WHERE id = 'mail-mixed'").run();
  db.prepare("INSERT INTO address (name, source_meta) VALUES ('other@example.test', NULL)").run();
  db.prepare("INSERT INTO users_address (user_id, address_id) VALUES (99, 2)").run();
  db.prepare("INSERT INTO emails (id, source, account_id, from_addr, to_addr, subject, text_body, html_body, received_at, is_read)"
    + " VALUES ('mail-foreign', 'cf_routing', 'foreign', 'noreply@x.ai', 'other@example.test', 's', 's', '', 5000, 0)").run();

  const scope = `(emails.account_id IN (
        SELECT uma.id FROM user_mail_accounts uma
        WHERE uma.user_id = ?
    )
    OR (
        emails.source = 'cf_routing'
        AND emails.to_addr COLLATE NOCASE IN (
            SELECT a.name FROM users_address ua
            JOIN address a ON a.id = ua.address_id
            WHERE ua.user_id = ?
              AND (a.source_meta IS NULL OR a.source_meta != 'external')
        )
    ))`;
  const rows = rowsFor(db, scope, [7, 7]);
  assert.deepEqual(rows.map((r) => r.id), ["mail-lower", "mail-mixed"]);

  // 反证：地址名二进制全等会漏掉混合大小写的本站邮件。
  const lossy = scope.replace("emails.to_addr COLLATE NOCASE IN", "emails.to_addr IN");
  assert.deepEqual(rowsFor(db, lossy, [7, 7]).map((r) => r.id), ["mail-lower"]);
  db.close();
});

test("normalizeRawMailAddress canonicalizes raw_mails.address", () => {
  assert.equal(normalizeRawMailAddress("  KevinWalters5892@Outlook.COM "), "kevinwalters5892@outlook.com");
  assert.equal(normalizeRawMailAddress(""), "");
  // 与 normalizeToAddr 同一契约：整地址小写（local + domain）
  assert.equal(normalizeRawMailAddress("Some.One+Tag@Gmail.com"), normalizeToAddr("Some.One+Tag@Gmail.com"));
});
