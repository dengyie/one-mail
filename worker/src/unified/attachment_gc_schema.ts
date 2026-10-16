export const ATTACHMENT_DELETE_GC_TRIGGER_NAME = "trg_emails_attachment_gc_after_delete_vps";

/**
 * The first attachment implementation called this locator column `r2_key`.
 * Production never stores object bytes in R2 anymore, but an already-created
 * D1 table can still carry that old column. Repair the table shape before any
 * current trigger or GC query touches it.
 */
export async function ensureAttachmentGcStorageKeySchema(db: D1Database, tableExists = true): Promise<void> {
    if (!tableExists) return;
    // A direct ALTER avoids a metadata round trip on every schema repair. The
    // expected "missing table/column" errors are safe: the caller creates the
    // current table immediately before/after this helper. Any other D1 error
    // must propagate so an unavailable database cannot be mistaken for a
    // healthy schema.
    try {
        await db.prepare("ALTER TABLE attachment_gc RENAME COLUMN r2_key TO storage_key").run();
    } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (!/no such table:\s*attachment_gc|no such column:.*r2_key/i.test(message)) throw cause;
    }
}

export const ATTACHMENT_DELETE_GC_TRIGGER_SQL = `
CREATE TRIGGER IF NOT EXISTS ${ATTACHMENT_DELETE_GC_TRIGGER_NAME}
AFTER DELETE ON emails
BEGIN
    INSERT INTO attachment_gc (storage_key, created_at, updated_at)
    SELECT json_extract(json_each.value, '$.storage_key'),
           CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
           CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
      FROM json_each(
          CASE WHEN json_valid(OLD.attachments_json)
                    AND json_type(OLD.attachments_json) = 'array'
               THEN OLD.attachments_json ELSE '[]' END
      )
     WHERE json_each.type = 'object'
       AND json_type(json_each.value, '$.storage_key') = 'text'
       AND length(json_extract(json_each.value, '$.storage_key')) = 51
       AND substr(json_extract(json_each.value, '$.storage_key'), 1, 8) = 'unified/'
       AND substr(json_extract(json_each.value, '$.storage_key'), 9) NOT GLOB '*[^A-Za-z0-9_-]*'
    ON CONFLICT(storage_key) DO UPDATE SET
        updated_at = MAX(excluded.updated_at, attachment_gc.updated_at + 1),
        attempts = 0,
        last_error = NULL
    WHERE attachment_gc.last_error IS NOT 'gc_in_progress'
       OR attachment_gc.updated_at <= excluded.updated_at - 600000;
END;
`;
