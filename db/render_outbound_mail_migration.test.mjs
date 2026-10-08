import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const migrations = [
  "2026-10-05-user-mail-accounts-can-send.sql",
  "2026-10-08-user-mail-accounts-smtp-proxy.sql",
].map(path => readFileSync(new URL(path, import.meta.url), "utf8"));

function python(source, input) {
  return spawnSync("python3", ["-c", `import json, sys\nimport render_outbound_mail_migration as m\n${source}`], {
    cwd: new URL(".", import.meta.url), input: JSON.stringify(input), encoding: "utf8",
  });
}

function render(sql, columns) {
  const result = python(
    'p=json.load(sys.stdin)\nprint(m.render_migration(p["sql"], set(p["columns"])), end="")',
    { sql, columns },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function migrate(db) {
  for (const sql of migrations) {
    const columns = db.prepare("PRAGMA table_info(user_mail_accounts)").all().map(row => row.name);
    db.exec(render(sql, columns));
  }
}

for (const partial of [false, true]) {
  test(`existing can_send repairs missing export columns; partial=${partial}`, t => {
    const db = new DatabaseSync(":memory:");
    t.after(() => db.close());
    db.exec("CREATE TABLE user_mail_accounts (id TEXT PRIMARY KEY, cred_enc TEXT, can_send INTEGER DEFAULT 0)");
    db.exec("INSERT INTO user_mail_accounts VALUES ('account', 'encrypted', 1)");
    if (partial) {
      db.exec("ALTER TABLE user_mail_accounts ADD COLUMN smtp_host TEXT");
      db.exec("UPDATE user_mail_accounts SET smtp_host = 'smtp.example.com'");
    }
    migrate(db);
    assert.deepEqual({ ...db.prepare("SELECT * FROM user_mail_accounts").get() }, {
      id: "account", cred_enc: "encrypted", can_send: 1,
      smtp_host: partial ? "smtp.example.com" : null,
      smtp_port: null, smtp_ssl: 1, proxy_policy: "auto",
    });
    const before = JSON.stringify(db.prepare("SELECT * FROM user_mail_accounts").all());
    migrate(db);
    assert.equal(JSON.stringify(db.prepare("SELECT * FROM user_mail_accounts").all()), before);
    const columns = db.prepare("PRAGMA table_info(user_mail_accounts)").all().map(row => row.name);
    for (const sql of migrations) assert.equal(render(sql, columns), "");
  });
}

test("can_send and fresh installation retain their migration contracts", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  for (const sql of migrations) assert.equal(render(sql, []), "");
  db.exec("CREATE TABLE user_mail_accounts (id TEXT PRIMARY KEY)");
  db.exec("INSERT INTO user_mail_accounts VALUES ('account')");
  migrate(db);
  assert.deepEqual({ ...db.prepare("SELECT can_send, smtp_ssl, proxy_policy FROM user_mail_accounts").get() }, {
    can_send: 0, smtp_ssl: 1, proxy_policy: "auto",
  });
});

test("malformed migration and failed schema queries fail closed", () => {
  const invalid = python('m.render_migration("DROP TABLE user_mail_accounts;", {"id"})', null);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /migration must contain only/);
  const failed = python('m.parse_remote_columns([{"success": False, "results": []}])', null);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /reported failure/);
});
