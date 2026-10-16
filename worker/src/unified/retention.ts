import { ATTACHMENT_GC_GRACE_MS, ATTACHMENT_GC_LEASE_MS, safeAttachmentKey } from "./attachments.ts";
import { deleteAttachmentObject } from "./storage_client.ts";

export function cutoffMs(days: number, nowMs: number): number {
    return nowMs - days * 24 * 60 * 60 * 1000;
}

const RETENTION_DAYS = 90;
const BODY_RETENTION_DAYS = 30;
const DEFAULT_BATCH_LIMIT = 1000;
const DEFAULT_MAX_BATCHES = 5;
const ATTACHMENT_GC_BATCH_LIMIT = 100;

type AttachmentGcRow = {
    storage_key: string;
    updated_at: number;
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
                ? (attachment as { storage_key?: unknown }).storage_key
                : null))
            .filter((key): key is string => safeAttachmentKey(key)))];
    } catch (error) {
        console.error("invalid attachment metadata; skipping attachment GC enqueue", error);
        return [];
    }
}

/**
 * One full `emails` scan answers this for every key at once. Asking per key
 * meant one scan per GC row (up to ATTACHMENT_GC_BATCH_LIMIT scans per drain),
 * which on a large mailbox is enough rows_read to trip the free-tier quota on
 * its own.
 */
const ATTACHMENT_REF_CHUNK = 50;

async function findReferencedAttachmentKeys(
    env: Bindings,
    keys: string[],
): Promise<Set<string>> {
    const referenced = new Set<string>();
    if (keys.length === 0) return referenced;
    for (let offset = 0; offset < keys.length; offset += ATTACHMENT_REF_CHUNK) {
        const chunk = keys.slice(offset, offset + ATTACHMENT_REF_CHUNK);
        const placeholders = chunk.map(() => "?").join(", ");
        const { results } = await env.DB.prepare(
            `SELECT DISTINCT json_extract(json_each.value, '$.storage_key') AS storage_key
             FROM emails, json_each(
                CASE WHEN json_valid(emails.attachments_json)
                          AND json_type(emails.attachments_json) = 'array'
                     THEN emails.attachments_json ELSE '[]' END
             )
             WHERE json_extract(json_each.value, '$.storage_key') IN (${placeholders})`,
        ).bind(...chunk).all<{ storage_key: string }>();
        for (const row of results ?? []) {
            if (typeof row?.storage_key === "string") referenced.add(row.storage_key);
        }
    }
    return referenced;
}

/**
 * Delete only objects that have no remaining email reference. The GC row is
 * durable, so a transient storage failure cannot make an already-committed DB
 * deletion lose its attachment permanently.
 */
async function drainAttachmentGc(env: Bindings): Promise<void> {
    if (!env.ATTACHMENT_STORAGE_URL || !env.ATTACHMENT_STORAGE_TOKEN) return;

    const { results } = await env.DB.prepare(
        `SELECT storage_key, updated_at FROM attachment_gc
         WHERE updated_at <= ?
         ORDER BY created_at ASC
         LIMIT ?`,
    ).bind(Date.now() - ATTACHMENT_GC_GRACE_MS, ATTACHMENT_GC_BATCH_LIMIT).all<AttachmentGcRow>();
    const rows = results ?? [];
    if (rows.length === 0) return;

    const keys = rows
        .map((row) => row?.storage_key)
        .filter((key): key is string => typeof key === "string" && key.length > 0);
    const referenced = await findReferencedAttachmentKeys(env, keys);

    for (const row of rows) {
        const key = row?.storage_key;
        if (typeof key !== "string" || key.length === 0) continue;
        const observedUpdatedAt = Number.isSafeInteger(row.updated_at)
            ? row.updated_at
            : Date.now() - ATTACHMENT_GC_GRACE_MS;
        if (referenced.has(key)) {
            await env.DB.prepare(
                `DELETE FROM attachment_gc WHERE storage_key = ? AND updated_at = ?`,
            ).bind(key, observedUpdatedAt).run();
            continue;
        }
        const leaseAt = Date.now();
        const lease = await env.DB.prepare(
            `UPDATE attachment_gc SET last_error = 'gc_in_progress', updated_at = ?
             WHERE storage_key = ? AND updated_at = ?`,
        ).bind(leaseAt, key, observedUpdatedAt).run();
        if (resultChanges(lease as D1Result<unknown>) === 0) continue;
        try {
            await deleteAttachmentObject(env, key);
        } catch (error) {
            await env.DB.prepare(
                `UPDATE attachment_gc
                    SET attempts = attempts + 1, last_error = ?, updated_at = ?
                  WHERE storage_key = ? AND last_error = 'gc_in_progress' AND updated_at = ?`,
            ).bind(String(error).slice(0, 500), Date.now(), key, leaseAt).run();
            console.error("attachment storage cleanup failed; retaining GC row", error);
            continue;
        }
        await env.DB.prepare(
            `DELETE FROM attachment_gc WHERE storage_key = ?
             AND last_error = 'gc_in_progress' AND updated_at = ?`,
        ).bind(key, leaseAt).run();
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
    // emails. Otherwise a queue created during a storage outage would remain stuck
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

        // Enqueue and delete in one D1 transaction. Object storage is deliberately not
        // touched until this final DB decision has committed.
        const keys = [...new Set(rows.flatMap((row) => attachmentKeys(row.attachments_json)))];
        const statements: D1PreparedStatement[] = [];
        if (keys.length) {
            statements.push(env.DB.prepare(
                `INSERT INTO attachment_gc (storage_key, created_at, updated_at)
                 SELECT value, ?, ? FROM json_each(?)
                 WHERE true
                 ON CONFLICT(storage_key) DO UPDATE SET
                   updated_at = excluded.updated_at,
                   attempts = 0,
                   last_error = NULL
                 WHERE attachment_gc.last_error IS NOT 'gc_in_progress'
                    OR attachment_gc.updated_at <= ?`,
            ).bind(Date.now(), Date.now(), JSON.stringify(keys), Date.now() - ATTACHMENT_GC_LEASE_MS));
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
