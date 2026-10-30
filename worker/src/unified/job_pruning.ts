/**
 * Terminal job rows were never deleted: `mail_mutation_jobs` and
 * `outbound_mail_jobs` only grew. That is not a direct rows_read cost — every
 * lookup is served by a `status`-leading index — but it inflates the table and
 * the index that every claim tick has to walk, and it quietly burns the free
 * tier's row-write budget forever.
 *
 * Pruning is bounded per run and only touches rows that have been terminal long
 * enough to be past any realistic debugging window, so it can never race a live
 * job: pending and processing rows are excluded by the status filter.
 *
 * Idempotency reservations are pruned on a different rule. A row whose job id is
 * filled in is what stops the same x-idempotency-key from sending twice, so it is
 * kept for good. A row with an empty job id is a reservation whose owner died
 * before writing its job; nothing it protects is still in flight, so it is
 * reclaimed once it is past the same window.
 */

import { ensureGmailRerouteIdempotencyTable } from "../core/gmail_reroute_idempotency.ts";

const DEFAULT_TERMINAL_RETENTION_DAYS = 30;
const DEFAULT_PRUNE_BATCH = 500;

const MUTATION_TERMINAL_STATUSES = "('succeeded', 'failed', 'unsupported', 'superseded')";
const OUTBOUND_TERMINAL_STATUSES = "('succeeded', 'failed', 'unsupported')";

function deletedRows(result: D1Result<unknown>): number {
    return Number((result.meta as { changes?: number } | undefined)?.changes ?? 0);
}

function boundedDays(value: number): number {
    if (!Number.isFinite(value) || value < 1) return DEFAULT_TERMINAL_RETENTION_DAYS;
    return Math.floor(value);
}

function boundedBatch(value: number): number {
    if (!Number.isFinite(value) || value < 1) return DEFAULT_PRUNE_BATCH;
    return Math.min(Math.floor(value), 5000);
}

export async function pruneTerminalJobs(
    env: Bindings,
    days: number = DEFAULT_TERMINAL_RETENTION_DAYS,
    batchLimit: number = DEFAULT_PRUNE_BATCH,
): Promise<{ mutation: number; outbound: number; idempotency: number }> {
    const cutoff = Date.now() - boundedDays(days) * 24 * 60 * 60 * 1000;
    const limit = boundedBatch(batchLimit);

    // rowid subquery keeps the delete bounded without needing (status, age)
    // to be indexable across two tables with different column sets.
    const mutation = await env.DB.prepare(
        `DELETE FROM mail_mutation_jobs
          WHERE rowid IN (
              SELECT rowid FROM mail_mutation_jobs
               WHERE status IN ${MUTATION_TERMINAL_STATUSES}
                 AND COALESCE(completed_at, updated_at) < ?
               LIMIT ?
          )`,
    ).bind(cutoff, limit).run();

    const outbound = await env.DB.prepare(
        `DELETE FROM outbound_mail_jobs
          WHERE rowid IN (
              SELECT rowid FROM outbound_mail_jobs
               WHERE status IN ${OUTBOUND_TERMINAL_STATUSES}
                 AND COALESCE(completed_at, updated_at) < ?
               LIMIT ?
          )`,
    ).bind(cutoff, limit).run();

    await ensureGmailRerouteIdempotencyTable(env.DB);
    const idempotency = await env.DB.prepare(
        `DELETE FROM gmail_reroute_idempotency
          WHERE rowid IN (
              SELECT rowid FROM gmail_reroute_idempotency
               WHERE (job_id IS NULL OR job_id = '')
                 AND created_at < ?
               LIMIT ?
          )`,
    ).bind(cutoff, limit).run();

    return {
        mutation: deletedRows(mutation),
        outbound: deletedRows(outbound),
        idempotency: deletedRows(idempotency),
    };
}