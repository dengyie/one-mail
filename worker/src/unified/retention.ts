export function cutoffMs(days: number, nowMs: number): number {
    return nowMs - days * 24 * 60 * 60 * 1000;
}

const RETENTION_DAYS = 90;
const BODY_RETENTION_DAYS = 30;
const DEFAULT_BATCH_LIMIT = 1000;
const DEFAULT_MAX_BATCHES = 5;
const ATTACHMENT_GC_BATCH_LIMIT = 100;

type AttachmentGcRow = {
    r2_key: string;
};

function positiveInteger(value: number, fallback: number): number {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function resultChanges(result: D1Result<unknown>): number {
    return Number((result.meta as { changes?: number } | undefined)?.changes ?? 0);
}

function attachmentKeys(attachmentsJson: string | null | undefined): string[] {
    try {
        const attachments = JSON.parse(attachmentsJson || "[]") as unknown;
        if (!Array.isArray(attachments)) return [];
        return [...new Set(attachments
            .map((attachment) => (attachment && typeof attachment === "object"
                ? (attachment as { r2_key?: unknown }).r2_key
                : null))
            .filter((key): key is string => typeof key === "string" && key.length > 0))];
    } catch (error) {
        console.error("invalid attachment metadata; skipping R2 GC enqueue", error);
        return [];
    }
}

/**
 * Delete only objects that have no remaining email reference. The GC row is
 * durable, so a transient R2 failure cannot make an already-committed DB
 * deletion lose its attachment permanently.
 */
async function drainAttachmentGc(env: Bindings): Promise<void> {
    const bucket = (env as { ATTACHMENTS?: R2Bucket }).ATTACHMENTS;
    if (!bucket) return;

    const { results } = await env.DB.prepare(
        `SELECT r2_key FROM attachment_gc
         ORDER BY created_at ASC
         LIMIT ?`,
    ).bind(ATTACHMENT_GC_BATCH_LIMIT).all<AttachmentGcRow>();

    for (const row of results ?? []) {
        const stillReferenced = await env.DB.prepare(
            `SELECT 1 FROM emails, json_each(COALESCE(emails.attachments_json, '[]'))
             WHERE json_extract(json_each.value, '$.r2_key') = ? LIMIT 1`,
        ).bind(row.r2_key).first();
        if (stillReferenced) {
            await env.DB.prepare(`DELETE FROM attachment_gc WHERE r2_key = ?`).bind(row.r2_key).run();
            continue;
        }
        try {
            await bucket.delete(row.r2_key);
        } catch (error) {
            await env.DB.prepare(
                `UPDATE attachment_gc
                    SET attempts = attempts + 1, last_error = ?, updated_at = ?
                  WHERE r2_key = ?`,
            ).bind(String(error).slice(0, 500), Date.now(), row.r2_key).run();
            console.error("r2 attachment cleanup failed; retaining GC row", error);
            continue;
        }
        await env.DB.prepare(`DELETE FROM attachment_gc WHERE r2_key = ?`).bind(row.r2_key).run();
    }
}

export async function purgeOldEmailBodies(
    env: Bindings,
    days: number = BODY_RETENTION_DAYS,
    batchLimit: number = DEFAULT_BATCH_LIMIT,
    maxBatches: number = DEFAULT_MAX_BATCHES,
): Promise<{ purged: number; limited: boolean }> {
    const cutoff = cutoffMs(days, Date.now());
    const safeBatchLimit = positiveInteger(batchLimit, DEFAULT_BATCH_LIMIT);
    const safeMaxBatches = positiveInteger(maxBatches, DEFAULT_MAX_BATCHES);
    let totalPurged = 0;
    let changes = 0;
    let batches = 0;
    do {
        if (batches >= safeMaxBatches) break;
        const { meta } = await env.DB.prepare(
            `UPDATE emails
             SET html_body = NULL,
                 text_body = '[Body purged for retention]'
             WHERE COALESCE(internal_date, received_at) < ?
               AND (is_starred IS NULL OR is_starred = 0)
               AND (html_body IS NOT NULL OR text_body != '[Body purged for retention]')
             LIMIT ?`
        ).bind(cutoff, safeBatchLimit).run();
        changes = resultChanges({ meta } as D1Result<unknown>);
        totalPurged += changes;
        batches += 1;
    } while (changes >= safeBatchLimit);
    return {
        purged: totalPurged,
        limited: batches >= safeMaxBatches && changes >= safeBatchLimit,
    };
}

export async function cleanupReadEmails(
    env: Bindings,
    days: number = RETENTION_DAYS,
    batchLimit: number = DEFAULT_BATCH_LIMIT,
    maxBatches: number = DEFAULT_MAX_BATCHES,
): Promise<{ deleted: number; limited: boolean }> {
    const cutoff = cutoffMs(days, Date.now());
    const safeBatchLimit = positiveInteger(batchLimit, DEFAULT_BATCH_LIMIT);
    const safeMaxBatches = positiveInteger(maxBatches, DEFAULT_MAX_BATCHES);
    // Drain previously committed rows even when this run has no newly eligible
    // emails. Otherwise a queue created during an R2 outage would remain stuck
    // forever once retention reaches an empty/fully retained mailbox.
    await drainAttachmentGc(env);
    let deleted = 0;
    let total = 0;
    let batches = 0;
    do {
        if (batches >= safeMaxBatches) break;
        const { results } = await env.DB.prepare(
            `SELECT id, attachments_json
             FROM emails
             WHERE is_read = 1
               AND received_at < ?
               AND (is_starred IS NULL OR is_starred = 0)
             LIMIT ?`
        ).bind(cutoff, safeBatchLimit).all<{ id: string; attachments_json: string | null }>();
        const rows = results ?? [];
        if (!rows.length) break;

        // Enqueue and delete in one D1 transaction. R2 is deliberately not
        // touched until this final DB decision has committed.
        const keys = [...new Set(rows.flatMap((row) => attachmentKeys(row.attachments_json)))];
        const statements: D1PreparedStatement[] = [];
        if (keys.length) {
            statements.push(env.DB.prepare(
                `INSERT OR IGNORE INTO attachment_gc (r2_key, created_at, updated_at)
                 SELECT value, ?, ? FROM json_each(?)`,
            ).bind(Date.now(), Date.now(), JSON.stringify(keys)));
        }
        statements.push(env.DB.prepare(
            `DELETE FROM emails
             WHERE is_read = 1
               AND received_at < ?
               AND (is_starred IS NULL OR is_starred = 0)
               AND id IN (SELECT value FROM json_each(?))`,
        ).bind(cutoff, JSON.stringify(rows.map((row) => row.id))));
        const batchResults = await env.DB.batch(statements);
        deleted = resultChanges(batchResults[batchResults.length - 1] as D1Result<unknown>);
        total += deleted;
        batches += 1;

        // A failed object delete leaves the attachment_gc row for the next
        // scheduled run; the email deletion above remains durable.
        await drainAttachmentGc(env);
    } while (deleted >= safeBatchLimit);
    return {
        deleted: total,
        limited: batches >= safeMaxBatches && deleted >= safeBatchLimit,
    };
}
