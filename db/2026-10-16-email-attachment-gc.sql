CREATE TRIGGER IF NOT EXISTS trg_emails_attachment_gc_after_delete
AFTER DELETE ON emails
BEGIN
    INSERT INTO attachment_gc (r2_key, created_at, updated_at)
    SELECT json_extract(json_each.value, '$.r2_key'),
           CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
           CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
      FROM json_each(
          CASE WHEN json_valid(OLD.attachments_json)
                    AND json_type(OLD.attachments_json) = 'array'
               THEN OLD.attachments_json ELSE '[]' END
      )
     WHERE json_each.type = 'object'
       AND json_type(json_each.value, '$.r2_key') = 'text'
       AND length(json_extract(json_each.value, '$.r2_key')) = 51
       AND substr(json_extract(json_each.value, '$.r2_key'), 1, 8) = 'unified/'
       AND substr(json_extract(json_each.value, '$.r2_key'), 9) NOT GLOB '*[^A-Za-z0-9_-]*'
    ON CONFLICT(r2_key) DO UPDATE SET
        updated_at = MAX(excluded.updated_at, attachment_gc.updated_at + 1),
        attempts = 0,
        last_error = NULL
    WHERE attachment_gc.last_error IS NOT 'gc_in_progress'
       OR attachment_gc.updated_at <= excluded.updated_at - 600000;
END;
