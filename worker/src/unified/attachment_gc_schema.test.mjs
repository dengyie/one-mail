import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ensureAttachmentGcStorageKeySchema } from "./attachment_gc_schema.ts";

function database() {
    const sqlite = new DatabaseSync(":memory:");
    return {
        sqlite,
        db: {
            prepare(sql) {
                let args = [];
                return {
                    bind(...values) { args = values; return this; },
                    async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; },
                    async all() { return { results: sqlite.prepare(sql).all(...args) }; },
                    async first() { return sqlite.prepare(sql).get(...args) ?? null; },
                };
            },
        },
    };
}

test("renames the old attachment GC locator and preserves rows", async () => {
    const { sqlite, db } = database();
    const key = `unified/${"k".repeat(43)}`;
    sqlite.exec(`CREATE TABLE attachment_gc (r2_key TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO attachment_gc(r2_key, attempts, created_at, updated_at) VALUES ('${key}', 2, 1, 2);`);
    await ensureAttachmentGcStorageKeySchema(db);
    assert.deepEqual(sqlite.prepare("PRAGMA table_info(attachment_gc)").all().map(row => row.name), [
        "storage_key", "attempts", "last_error", "created_at", "updated_at",
    ]);
    assert.deepEqual({ ...sqlite.prepare("SELECT storage_key, attempts FROM attachment_gc").get() }, { storage_key: key, attempts: 2 });
    sqlite.close();
});

test("does nothing when the current locator column is already present", async () => {
    const { sqlite, db } = database();
    sqlite.exec("CREATE TABLE attachment_gc (storage_key TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
    await ensureAttachmentGcStorageKeySchema(db);
    assert.deepEqual(sqlite.prepare("PRAGMA table_info(attachment_gc)").all().map(row => row.name), [
        "storage_key", "attempts", "created_at", "updated_at",
    ]);
    sqlite.close();
});

test("still renames when a trigger referencing storage_key blocks the ALTER", async () => {
    // 2026-11-20 shard1 incident: the delete trigger was recreated with the new
    // SQL while the table still carried r2_key. SQLite parses trigger columns
    // lazily, so the rename failed with "no such column: storage_key" — the old
    // regex only tolerated "no such column: r2_key" and initialize 500'd forever.
    const { sqlite, db } = database();
    sqlite.exec(`CREATE TABLE emails (id TEXT PRIMARY KEY, attachments_json TEXT);
      CREATE TABLE attachment_gc (r2_key TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TRIGGER trg_emails_attachment_gc_after_delete_vps AFTER DELETE ON emails
      BEGIN
          INSERT INTO attachment_gc (storage_key, created_at, updated_at)
          VALUES ('unified/placeholder', 1, 1);
      END;`);
    await ensureAttachmentGcStorageKeySchema(db);
    assert.deepEqual(sqlite.prepare("PRAGMA table_info(attachment_gc)").all().map(row => row.name), [
        "storage_key", "attempts", "last_error", "created_at", "updated_at",
    ]);
    sqlite.close();
});
