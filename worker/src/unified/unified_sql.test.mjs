import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { UNIFIED_EMAIL_SELECT } from "./unified_sql.ts";

test("unified list marks only structurally valid private attachment keys downloadable", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE emails (id TEXT, source TEXT, account_id TEXT, from_addr TEXT, to_addr TEXT, subject TEXT, internal_date INTEGER, received_at INTEGER, is_read INTEGER, is_starred INTEGER, attachments_json TEXT)");
  const valid = `unified/${"a".repeat(43)}`;
  db.prepare("INSERT INTO emails VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "mail-1", "imap_custom", "account-1", "from", "to", "subject", 1, 1, 0, 0,
    JSON.stringify([
      { id: "ok", size: 2, storage_key: valid },
      { id: "bad-key", size: 2, storage_key: "unified/not-a-key" },
      { id: "bad-size", size: 40 * 1024 * 1024, storage_key: valid },
      { id: "bad/id", size: 2, storage_key: valid },
    ]),
  );
  const row = db.prepare(`${UNIFIED_EMAIL_SELECT} WHERE id = ?`).get("mail-1");
  const attachments = JSON.parse(row.attachments_json);
  assert.deepEqual(attachments.map(item => item.downloadable), [true, false, false, false]);
  assert.ok(attachments.every(item => !Object.hasOwn(item, "storage_key")));
  db.close();
});
