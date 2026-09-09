export function cutoffMs(days: number, nowMs: number): number {
    return nowMs - days * 24 * 60 * 60 * 1000;
}

const RETENTION_DAYS = 90;
const BODY_RETENTION_DAYS = 30;
const DEFAULT_BATCH_LIMIT = 1000;
const DEFAULT_MAX_BATCHES = 5;

function positiveInteger(value: number, fallback: number): number {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
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
        changes = (meta as { changes?: number })?.changes ?? 0;
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
    const bucket = (env as { ATTACHMENTS?: R2Bucket }).ATTACHMENTS;
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
        ).bind(cutoff, safeBatchLimit).all();
        const rows = (results ?? []) as { id: string; attachments_json: string }[];
        if (!rows.length) break;
        if (bucket) {
            for (const r of rows) {
                try {
                    const atts = JSON.parse(r.attachments_json || "[]") as { r2_key?: string }[];
                    for (const a of atts) {
                        if (a.r2_key) await bucket.delete(a.r2_key);
                    }
                } catch (e) {
                    console.error("r2 delete error", e);
                    throw new Error("r2 attachment cleanup failed");
                }
            }
        }
        const ids = rows.map((r) => r.id);
        const placeholders = ids.map(() => "?").join(",");
        const { meta } = await env.DB.prepare(
            `DELETE FROM emails
             WHERE is_read = 1
               AND received_at < ?
               AND (is_starred IS NULL OR is_starred = 0)
               AND id IN (${placeholders})`
        ).bind(cutoff, ...ids).run();
        deleted = (meta as { changes?: number })?.changes ?? 0;
        total += deleted;
        batches += 1;
    } while (deleted >= safeBatchLimit);
    return {
        deleted: total,
        limited: batches >= safeMaxBatches && deleted >= safeBatchLimit,
    };
}