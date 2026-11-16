import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { listRawMails, countRawMails, getRawMail } from "./mail-list.ts";
import { normalizeRawMailAddress } from "../unified/addr_case.ts";

/**
 * raw_mails.address 大小写契约回归（2026-11-16 PR #180 全仓审计的残留面）。
 *
 * 事故同类根因：raw_mails.address 入库保留 message.to 的 local part 原始
 * 大小写，而读路径（/api/mails、webhook 查 id、地址级联删除）按字节精确
 * `=` 比较 —— 「原始邮件在库里，地址维度的读/删全部失明」。
 *
 * 契约（见 unified/addr_case.ts）：
 * - 存储最大表、只有二进制索引 ⇒ **写侧统一小写 + 读侧绑定前归一**，
 *   热路径保持字节精确 `=` 吃 idx_raw_mails_address；
 * - DELETE/清理是低频操作且「残留=隐私问题 / 误删=数据丢失」，
 *   允许 COLLATE NOCASE 容错（放弃索引）。
 */

const makeDb = () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE raw_mails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT,
    address TEXT,
    message_id TEXT,
    raw TEXT
  )`);
  db.exec(`CREATE INDEX idx_raw_mails_address ON raw_mails(address)`);
  db.exec(`CREATE TABLE address (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE)`);
  return db;
};

const seed = (db, address, messageId = "<m@x>") => {
  db.prepare(`INSERT INTO raw_mails (source, address, message_id, raw) VALUES ('cf_routing', ?, ?, 'RAW')`)
    .run(normalizeRawMailAddress(address), messageId);
};

// D1 facade over node:sqlite（mail-list 只用 prepare→bind→all/first）
const d1 = (db) => ({
  prepare: (sql) => {
    const stmt = db.prepare(sql);
    return {
      bind: (...args) => ({
        all: async () => ({ results: stmt.all(...args) }),
        first: async (col) => {
          const row = stmt.get(...args);
          if (row === undefined || row === null) return null;
          return col == null ? row : row[col];
        },
        run: async () => ({ success: true }),
      }),
    };
  },
});
const ctx = (db) => ({ env: { DB: d1(db) } });

test("mail-list 读侧把入参归一成规范形后命中小写存量行", async () => {
  const db = makeDb();
  seed(db, "KevinWalters5892@outlook.com");
  const c = ctx(db);
  // 入参混合大小写（调用方传什么都能落底，归一在 mail-list 边界内做）
  assert.equal(await countRawMails(c, "KevinWalters5892@OUTLOOK.com"), 1);
  assert.equal((await listRawMails(c, "KevinWalters5892@outlook.com")).length, 1);
  const id = (await listRawMails(c, "kevinwalters5892@outlook.com"))[0].id;
  assert.ok(await getRawMail(c, id, "  KevinWalters5892@outlook.com "));
  // 规范形之外的字节序列（不存在的历史行形态）查不到 —— 与「库内只有
  // 规范形」的存储契约一致
  assert.equal(await countRawMails(c, "not-there@outlook.com"), 0);
});

test("DELETE/清理路径对混合大小写行保持 NOCASE 容错（源码契约锁）", () => {
  const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
  const common = read("../common.ts");
  const addressApi = read("../admin_api/address_api.ts");
  const adminMail = read("../admin_api/admin_mail_api.ts");
  const emailIndex = read("../email/index.ts");
  // 地址级联删除不得在 raw_mails 留混合大小写残留（隐私）
  assert.ok(common.includes("DELETE FROM raw_mails WHERE address COLLATE NOCASE IN"), "batchDeleteAddressWithData");
  assert.ok(addressApi.includes("DELETE FROM raw_mails WHERE address COLLATE NOCASE IN"), "address_api delete/clearInbox");
  // mails_unknow 清理不得误删「address 行存在但大小写不同」的原始邮件（数据丢失）
  assert.ok(common.includes("WHERE address COLLATE NOCASE NOT IN (SELECT name FROM address)"), "cleanMails mails_unknow");
  // emptyAddress 判空必须大小写不敏感，否则只剩混合大小写原始邮件的地址行被误删
  assert.ok(common.includes("name COLLATE NOCASE NOT IN (SELECT DISTINCT address FROM raw_mails"), "cleanMails emptyAddress");
  // admin 未知邮件列表同语义
  assert.ok(adminMail.includes("address COLLATE NOCASE NOT IN (select name from address)"), "getUnknowMails");
  // 入口守卫：历史混合大小写 address.name 不应误拒收信
  assert.ok(emailIndex.includes("name = ? COLLATE NOCASE"), "ingress unknown-address guard");
});

test("webhook 邮件 id 查找绑定前归一（源码契约锁）", () => {
  const common = readFileSync(fileURLToPath(new URL("../common.ts", import.meta.url)), "utf8");
  assert.ok(
    common.includes(").bind(normalizeRawMailAddress(address), message_id).first<string>(\"id\")"),
    "webhook mailId lookup must normalize the address bind",
  );
});
