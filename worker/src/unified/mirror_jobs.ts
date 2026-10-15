import type { Context } from "hono";
import { resolveRawEmail } from "../gzip.ts";
import type { RawMailRow } from "../models/index.ts";
import { saveUnifiedEmail } from "./unified_store.ts";

const MIRROR_BATCH_LIMIT = 20;
const MIRROR_RECONCILE_BATCH_LIMIT = 100;
const MIRROR_BASE_DELAY_MS = 60_000;
const MIRROR_MAX_DELAY_MS = 6 * 60 * 60 * 1000;
const MIRROR_LEASE_MS = 5 * 60 * 1000;

const changes = (result: D1Result<unknown>): number =>
    Number((result.meta as { changes?: number } | undefined)?.changes ?? 0);

export async function enqueueUnifiedMirror(
    env: Bindings,
    rawMailId: number,
    unifiedId: string,
    error: unknown,
): Promise<void> {
    const now = Date.now();
    await env.DB.batch([
        env.DB.prepare(`INSERT INTO unified_mirror_jobs
            (unified_id, raw_mail_id, next_attempt_at, attempts, last_error, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?, ?)
         ON CONFLICT(unified_id) DO UPDATE SET
            next_attempt_at = excluded.next_attempt_at,
            last_error = excluded.last_error,
            updated_at = excluded.updated_at`).bind(
            unifiedId, rawMailId, now,
            error instanceof Error ? error.name.slice(0, 100) : "UnknownError", now, now,
        ),
        env.DB.prepare(
            `UPDATE raw_mails SET mirror_pending = 0 WHERE unified_id = ? AND mirror_pending = 1`,
        ).bind(unifiedId),
    ]);
}

export async function markUnifiedMirrorComplete(env: Bindings, unifiedId: string): Promise<void> {
    await env.DB.prepare(
        `UPDATE raw_mails SET mirror_pending = 0 WHERE unified_id = ? AND mirror_pending = 1`,
    ).bind(unifiedId).run();
}

/**
 * Recover native rows whose first mirror failed before a retry row could be
 * written. Queue creation and marker clearing share one atomic D1 batch.
 */
export async function reconcileUnifiedMirrorJobs(
    env: Bindings,
    limit = MIRROR_RECONCILE_BATCH_LIMIT,
): Promise<number> {
    const safeLimit = Number.isSafeInteger(limit) && limit > 0
        ? Math.min(limit, MIRROR_RECONCILE_BATCH_LIMIT)
        : MIRROR_RECONCILE_BATCH_LIMIT;
    const { results } = await env.DB.prepare(
        `SELECT rm.id AS raw_mail_id, rm.unified_id, e.id AS unified_email_id,
                j.unified_id AS queued_unified_id
           FROM raw_mails rm
           LEFT JOIN emails e ON e.id = rm.unified_id
           LEFT JOIN unified_mirror_jobs j ON j.unified_id = rm.unified_id
          WHERE rm.mirror_pending = 1
          ORDER BY rm.id ASC
          LIMIT ?`,
    ).bind(safeLimit).all<{
        raw_mail_id: number;
        unified_id: string | null;
        unified_email_id: string | null;
        queued_unified_id: string | null;
    }>();
    const page = results ?? [];
    if (!page.length) return 0;

    const now = Date.now();
    const rawMailIds = JSON.stringify(page.map(row => row.raw_mail_id));
    const resultsAfterBatch = await env.DB.batch([
        env.DB.prepare(`INSERT OR IGNORE INTO unified_mirror_jobs
                (unified_id, raw_mail_id, next_attempt_at, attempts, last_error, created_at, updated_at)
             SELECT rm.unified_id, rm.id, ?, 0, 'reconciled', ?, ?
               FROM raw_mails rm
               LEFT JOIN emails e ON e.id = rm.unified_id
               LEFT JOIN unified_mirror_jobs j ON j.unified_id = rm.unified_id
              WHERE rm.id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
                AND rm.unified_id IS NOT NULL
                AND e.id IS NULL
                AND j.unified_id IS NULL`).bind(now, now, now, rawMailIds),
        env.DB.prepare(`UPDATE raw_mails SET mirror_pending = 0
              WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
                AND mirror_pending = 1`).bind(rawMailIds),
    ]);
    return changes(resultsAfterBatch[0]);
}

type MirrorRow = RawMailRow & {
    raw_mail_id: number;
    job_unified_id: string;
    attempts: number;
    id?: number | null;
    unified_id?: string | null;
};

export async function processUnifiedMirrorJobs(
    env: Bindings,
    limit = MIRROR_BATCH_LIMIT,
): Promise<{ succeeded: number; retried: number; dropped: number }> {
    const safeLimit = Number.isSafeInteger(limit) && limit > 0
        ? Math.min(limit, MIRROR_BATCH_LIMIT)
        : MIRROR_BATCH_LIMIT;
    const { results } = await env.DB.prepare(
        `SELECT j.raw_mail_id, j.unified_id AS job_unified_id, j.attempts, rm.*
         FROM unified_mirror_jobs j
         LEFT JOIN raw_mails rm ON rm.unified_id = j.unified_id
         WHERE j.next_attempt_at <= ?
         ORDER BY j.created_at ASC
         LIMIT ?`,
    ).bind(Date.now(), safeLimit).all<MirrorRow>();
    let succeeded = 0;
    let retried = 0;
    let dropped = 0;
    for (const row of results ?? []) {
        const dueAt = Date.now();
        const leaseUntil = dueAt + MIRROR_LEASE_MS;
        const lease = await env.DB.prepare(
            `UPDATE unified_mirror_jobs
                SET next_attempt_at = ?, updated_at = ?
              WHERE unified_id = ? AND next_attempt_at <= ?`,
        ).bind(leaseUntil, dueAt, row.job_unified_id, dueAt).run();
        if (changes(lease) !== 1) continue;
        if (!Number.isSafeInteger(row.id) || typeof row.unified_id !== "string" || !row.unified_id) {
            await env.DB.batch([
                env.DB.prepare(
                    `UPDATE raw_mails SET mirror_pending = 0 WHERE unified_id = ? AND mirror_pending = 1`,
                ).bind(row.unified_id),
                env.DB.prepare(
                    `DELETE FROM unified_mirror_jobs WHERE unified_id = ? AND next_attempt_at = ?`,
                ).bind(row.job_unified_id, leaseUntil),
            ]);
            dropped++;
            continue;
        }
        try {
            const raw = await resolveRawEmail(row);
            if (!raw) throw new Error("raw email is empty");
            await saveUnifiedEmail(
                { env } as Context<HonoCustomType>,
                raw,
                row.source || "unknown",
                row.address || "",
                row.unified_id,
            );
            await env.DB.batch([
                env.DB.prepare(
                    `UPDATE raw_mails SET mirror_pending = 0 WHERE unified_id = ? AND mirror_pending = 1`,
                ).bind(row.unified_id),
                env.DB.prepare(
                    `DELETE FROM unified_mirror_jobs WHERE unified_id = ? AND next_attempt_at = ?`,
                ).bind(row.job_unified_id, leaseUntil),
            ]);
            succeeded++;
        } catch (error) {
            const attempts = Number.isSafeInteger(row.attempts) && row.attempts >= 0
                ? row.attempts + 1 : 1;
            const delay = Math.min(MIRROR_MAX_DELAY_MS, MIRROR_BASE_DELAY_MS * (2 ** Math.min(attempts - 1, 9)));
            const errorType = error instanceof Error ? error.name.slice(0, 100) : "UnknownError";
            await env.DB.prepare(
                `UPDATE unified_mirror_jobs
                    SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
                  WHERE unified_id = ? AND next_attempt_at = ?`,
            ).bind(attempts, Date.now() + delay, errorType, Date.now(), row.job_unified_id, leaseUntil).run();
            retried++;
            console.error("unified email mirror retry scheduled", { raw_mail_id: row.raw_mail_id, attempts, error_type: errorType });
        }
    }
    return { succeeded, retried, dropped };
}
