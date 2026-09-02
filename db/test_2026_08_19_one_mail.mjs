import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";

const sql = readFileSync(new URL("./2026-08-19-one-mail.sql", import.meta.url), "utf8");
const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
const pop3MigrationPath = new URL("./2026-08-24-user-mail-pop3.sql", import.meta.url);
const pop3Migration = existsSync(pop3MigrationPath) ? readFileSync(pop3MigrationPath, "utf8") : null;

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

test("fresh schema contains the complete POP3 and uniqueness contract", () => {
  const db = new Database(":memory:");
  db.exec(schema);
  const columns = db.prepare("PRAGMA table_info(user_mail_accounts)").all().map((c) => c.name);
  assert.deepEqual(columns.slice(11, 16), ["use_ssl", "pop3_host", "pop3_port", "pop3_ssl", "pop3_use_stls"]);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_user_mail_accounts_username_uq'").get(),
    { name: "idx_user_mail_accounts_username_uq" });
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('emails','mail_accounts','api_keys') ORDER BY name").all(),
    [{ name: "api_keys" }, { name: "emails" }, { name: "mail_accounts" }]);
  db.close();
});

test("POP3 dated SQL is documentation-only and cannot be mistaken for a retryable runner", () => {
  if (!pop3Migration) return;
  assert.match(pop3Migration, /not a standalone executable migration/);
  assert.doesNotMatch(pop3Migration, /^ALTER TABLE .*ADD COLUMN/m);
});

test("legacy POP3 shape can be repaired repeatedly without duplicate columns", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE user_mail_accounts (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
    source TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL, username TEXT NOT NULL,
    cred_enc TEXT NOT NULL, protocol TEXT DEFAULT 'auto', folders_json TEXT, oauth_enc TEXT,
    enabled INTEGER DEFAULT 1, last_sync_at INTEGER, last_error TEXT, created_at INTEGER);`);
  const columns = new Set();
  for (const [name, definition] of [["use_ssl", "INTEGER DEFAULT 1"], ["pop3_host", "TEXT"], ["pop3_port", "INTEGER"], ["pop3_ssl", "INTEGER"], ["pop3_use_stls", "INTEGER DEFAULT 0"]]) {
    if (!columns.has(name)) { db.exec(`ALTER TABLE user_mail_accounts ADD COLUMN ${name} ${definition}`); columns.add(name); }
  }
  for (const [name] of [["use_ssl"], ["pop3_host"], ["pop3_port"], ["pop3_ssl"], ["pop3_use_stls"]]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE user_mail_accounts ADD COLUMN ${name} TEXT`);
  }
  assert.deepEqual(db.prepare("PRAGMA table_info(user_mail_accounts)").all().map((c) => c.name).slice(-5),
    ["use_ssl", "pop3_host", "pop3_port", "pop3_ssl", "pop3_use_stls"]);
  db.close();
});