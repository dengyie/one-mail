import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";

const sql = readFileSync(new URL("./2026-08-19-one-mail.sql", import.meta.url), "utf8");

test("one-mail migration creates emails/mail_accounts/api_keys with expected columns", () => {
  const db = new Database(":memory:");
  db.exec(sql);

  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

  assert.deepEqual(cols("emails"), [
    "id","source","account_id","from_addr","to_addr","subject","text_body",
    "html_body","received_at","internal_date","headers_json","is_read",
    "flags_json","attachments_json","raw_ref","imap_uid","updated_at",
  ]);
  assert.deepEqual(cols("mail_accounts"),
    ["id","source_type","name","config_json","enabled","last_sync_at","created_at"]);
  assert.deepEqual(cols("api_keys"),
    ["id","name","key_hash","role","allowed_sources","allowed_accounts","enabled","created_at","last_used_at"]);

  // imap_uid 部分唯一索引：同键重复插入被拒，NULL 不冲突
  db.prepare(`INSERT INTO emails (id,source,from_addr,to_addr,received_at,imap_uid)
              VALUES ('a','imap_qq','f','t',1,'h:f:1:100')`).run();
  assert.throws(() =>
    db.prepare(`INSERT INTO emails (id,source,from_addr,to_addr,received_at,imap_uid)
                VALUES ('b','imap_qq','f','t',1,'h:f:1:100')`).run());
  db.prepare(`INSERT INTO emails (id,source,from_addr,to_addr,received_at,imap_uid)
              VALUES ('c','cf_routing','f','t',1,NULL)`).run();
  db.prepare(`INSERT INTO emails (id,source,from_addr,to_addr,received_at,imap_uid)
              VALUES ('d','cf_routing','f','t',1,NULL)`).run(); // 第二个 NULL 也允许
  db.close();
});