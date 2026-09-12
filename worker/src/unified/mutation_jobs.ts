import { Context } from "hono";

import { checkRowAccess } from "./auth_scope.ts";

export type MailMutationOperation = "set_read" | "set_starred";
export type MailMutationTerminalStatus = "succeeded" | "failed" | "unsupported" | "superseded";

const MAX_ATTEMPTS = 5;
const MAX_CLAIM = 50;
const LEASE_MS = 60_000;
const MAX_RETRY_MS = 5 * 60_000;

export type MutableEmailRow = {
    id: string;
    source: string | null;
    account_id: string | null;
    to_addr: string | null;
    is_read: number | null;
    is_starred: number | null;
    provider: string | null;
    source_folder: string | null;
    source_folder_id: string | null;
    provider_message_id: string | null;
    source_key: string | null;
    imap_uid: string | null;
};

type MutationJobRow = {
    id: string;
    email_id: string;
    account_id: string;
    provider: string;
    operation: MailMutationOperation;
    desired_value: number;
    source_folder: string | null;
    source_folder_id: string | null;
    provider_message_id: string | null;
    source_key: string | null;
    status: string;
    attempts: number;
    next_attempt_at: number;
    lease_token: string | null;
    lease_until: number | null;
    last_error: string | null;
    created_at: number;
    updated_at: number;
    completed_at: number | null;
};

const mutationEmailSelect = `SELECT id, source, account_id, to_addr, is_read, is_starred,
    provider, source_folder, source_folder_id, provider_message_id, source_key, imap_uid
    FROM emails WHERE id = ?`;

export const inferMutationProvider = (row: Pick<MutableEmailRow, "provider" | "source" | "source_key" | "imap_uid">): string => {
    const explicit = String(row.provider || "").trim().toLowerCase();
    if (explicit) return explicit;
    const key = String(row.source_key || row.imap_uid || "").toLowerCase();
    if (key.startsWith("graph:")) return "graph";
    if (key.startsWith("pop3:")) return "pop3";
    if (key) return "imap";
    const source = String(row.source || "").toLowerCase();
    if (source === "cf_routing" || source === "cloudflare") return "native";
    if (source === "graph_outlook") return "graph";
    if (source.startsWith("imap_")) return "imap";
    return "unknown";
};

export const providerMutationSupport = (
    row: MutableEmailRow,
): { ok: true; provider: "native" | "imap" | "graph" } | { ok: false; provider: string; code: string } => {
    const provider = inferMutationProvider(row);
    if (provider === "native") return { ok: true, provider };
    if (!row.account_id) return { ok: false, provider, code: "missing_mail_account_identity" };
    if (provider === "pop3") return { ok: false, provider, code: "provider_write_unsupported" };
    if (provider === "graph") {
        return row.provider_message_id
            ? { ok: true, provider }
            : { ok: false, provider, code: "missing_provider_message_identity" };
    }
    if (provider === "imap") {
        return (row.source_folder && (row.source_key || row.imap_uid))
            ? { ok: true, provider }
            : { ok: false, provider, code: "missing_imap_message_identity" };
    }
    return { ok: false, provider, code: "provider_write_unsupported" };
};

const updateNativeState = async (
    c: Context<HonoCustomType>,
    row: MutableEmailRow,
    operation: MailMutationOperation,
    desired: number,
) => {
    const column = operation === "set_read" ? "is_read" : "is_starred";
    await c.env.DB.prepare(`UPDATE emails SET ${column} = ?, updated_at = ? WHERE id = ?`)
        .bind(desired, Date.now(), row.id).run();
    return c.json({
        ok: true,
        status: "succeeded",
        operation,
        desired_value: desired,
        ...(operation === "set_read" ? { is_read: desired } : { is_starred: desired }),
    });
};

const queueExternalMutation = async (
    c: Context<HonoCustomType>,
    row: MutableEmailRow,
    provider: "imap" | "graph",
    operation: MailMutationOperation,
    desired: number,
) => {
    const now = Date.now();
    const id = crypto.randomUUID();

    // A newer desired state makes older not-yet-started writes obsolete. A job
    // already processing is allowed to finish, and the newer pending job runs
    // afterwards to converge the provider to the latest user intent.
    await c.env.DB.prepare(
        `UPDATE mail_mutation_jobs
            SET status = 'superseded', completed_at = ?, updated_at = ?
          WHERE email_id = ? AND operation = ? AND status = 'pending'`,
    ).bind(now, now, row.id, operation).run();

    await c.env.DB.prepare(
        `INSERT INTO mail_mutation_jobs (
            id, email_id, account_id, provider, operation, desired_value,
            source_folder, source_folder_id, provider_message_id, source_key,
            status, attempts, next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?)`,
    ).bind(
        id,
        row.id,
        row.account_id,
        provider,
        operation,
        desired,
        row.source_folder,
        row.source_folder_id,
        row.provider_message_id,
        row.source_key || row.imap_uid,
        now,
        now,
    ).run();

    return c.json({
        ok: true,
        status: "queued",
        job_id: id,
        operation,
        desired_value: desired,
    }, 202);
};

const mutateMessageState = async (
    c: Context<HonoCustomType>,
    operation: MailMutationOperation,
    explicitDesired?: number,
) => {
    const id = c.req.param("id");
    const row = await c.env.DB.prepare(mutationEmailSelect).bind(id).first<MutableEmailRow>();
    if (!row) return c.json({ error: "not found" }, 404);
    if (!(await checkRowAccess(c, row))) return c.json({ error: "forbidden" }, 403);

    let desired: number;
    if (explicitDesired === 0 || explicitDesired === 1) {
        desired = explicitDesired;
    } else if (operation === "set_read") {
        desired = row.is_read === 1 ? 0 : 1;
    } else {
        desired = row.is_starred === 1 ? 0 : 1;
    }

    const support = providerMutationSupport(row);
    if (!support.ok) {
        return c.json({
            error: "provider mutation unsupported",
            status: "unsupported",
            code: support.code,
            provider: support.provider,
            operation,
        }, 409);
    }
    if (support.provider === "native") {
        return updateNativeState(c, row, operation, desired);
    }
    return queueExternalMutation(c, row, support.provider, operation, desired);
};

export const markRead = (c: Context<HonoCustomType>) => mutateMessageState(c, "set_read", 1);
export const markUnread = (c: Context<HonoCustomType>) => mutateMessageState(c, "set_read", 0);

export const toggleStar = async (c: Context<HonoCustomType>) => {
    const body = await c.req.json<{ is_starred?: number }>().catch(() => ({}));
    const desired = typeof body?.is_starred === "number" ? (body.is_starred ? 1 : 0) : undefined;
    return mutateMessageState(c, "set_starred", desired);
};

export const getMutationStatus = async (c: Context<HonoCustomType>) => {
    const job = await c.env.DB.prepare(
        `SELECT id, email_id, operation, desired_value, status, attempts, last_error,
                created_at, updated_at, completed_at
           FROM mail_mutation_jobs WHERE id = ?`,
    ).bind(c.req.param("id")).first<MutationJobRow>();
    if (!job) return c.json({ error: "not found" }, 404);

    const row = await c.env.DB.prepare(
        `SELECT id, source, account_id, to_addr FROM emails WHERE id = ?`,
    ).bind(job.email_id).first<{ id: string; source?: string | null; account_id?: string | null; to_addr?: string | null }>();
    if (!row) return c.json({ error: "not found" }, 404);
    if (!(await checkRowAccess(c, row))) return c.json({ error: "forbidden" }, 403);

    return c.json({
        id: job.id,
        email_id: job.email_id,
        operation: job.operation,
        desired_value: job.desired_value,
        status: job.status,
        attempts: job.attempts,
        error: job.last_error,
        created_at: job.created_at,
        updated_at: job.updated_at,
        completed_at: job.completed_at,
    });
};

export const claimMutationJobs = async (c: Context<HonoCustomType>) => {
    const body = await c.req.json<{ lease_token?: string; limit?: number }>().catch(() => ({}));
    const leaseToken = typeof body.lease_token === "string" ? body.lease_token.trim() : "";
    const requested = Number(body.limit ?? 20);
    if (!leaseToken || leaseToken.length > 200 || !Number.isInteger(requested) || requested < 1 || requested > MAX_CLAIM) {
        return c.json({ error: "invalid claim request" }, 400);
    }

    const now = Date.now();
    const leaseUntil = now + LEASE_MS;

    // Recover crashed workers. A processing job whose lease expired becomes
    // claimable again with the same desired-state operation.
    await c.env.DB.prepare(
        `UPDATE mail_mutation_jobs
            SET status = 'pending', lease_token = NULL, lease_until = NULL, updated_at = ?
          WHERE status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?`,
    ).bind(now, now).run();

    const { results } = await c.env.DB.prepare(
        `SELECT id FROM mail_mutation_jobs j
          WHERE j.status = 'pending'
            AND j.next_attempt_at <= ?
            AND NOT EXISTS (
                SELECT 1 FROM mail_mutation_jobs p
                 WHERE p.email_id = j.email_id
                   AND p.operation = j.operation
                   AND p.status = 'processing'
            )
          ORDER BY j.created_at ASC, j.id ASC
          LIMIT ?`,
    ).bind(now, requested).all<{ id: string }>();

    for (const candidate of results || []) {
        await c.env.DB.prepare(
            `UPDATE mail_mutation_jobs
                SET status = 'processing', attempts = attempts + 1,
                    lease_token = ?, lease_until = ?, updated_at = ?
              WHERE id = ? AND status = 'pending' AND next_attempt_at <= ?`,
        ).bind(leaseToken, leaseUntil, now, candidate.id, now).run();
    }

    const claimed = await c.env.DB.prepare(
        `SELECT id, email_id, account_id, provider, operation, desired_value,
                source_folder, source_folder_id, provider_message_id, source_key,
                status, attempts, lease_token, lease_until, created_at
           FROM mail_mutation_jobs
          WHERE status = 'processing' AND lease_token = ?
          ORDER BY created_at ASC, id ASC`,
    ).bind(leaseToken).all<MutationJobRow>();

    return c.json({ jobs: claimed.results || [], lease_until: leaseUntil });
};

export const reportMutationResult = async (c: Context<HonoCustomType>) => {
    const body = await c.req.json<{
        lease_token?: string;
        status?: "succeeded" | "retry" | "failed" | "unsupported";
        error?: string;
        retry_after_ms?: number;
    }>().catch(() => ({}));
    const leaseToken = typeof body.lease_token === "string" ? body.lease_token.trim() : "";
    const requestedStatus = body.status;
    if (!leaseToken || !["succeeded", "retry", "failed", "unsupported"].includes(String(requestedStatus))) {
        return c.json({ error: "invalid mutation result" }, 400);
    }

    const job = await c.env.DB.prepare(
        `SELECT * FROM mail_mutation_jobs
          WHERE id = ? AND status = 'processing' AND lease_token = ?`,
    ).bind(c.req.param("id"), leaseToken).first<MutationJobRow>();
    if (!job) return c.json({ error: "stale or unknown lease" }, 409);

    const now = Date.now();
    const error = body.error ? String(body.error).slice(0, 500) : null;
    const newer = await c.env.DB.prepare(
        `SELECT 1 FROM mail_mutation_jobs
          WHERE email_id = ? AND operation = ?
            AND (created_at > ? OR (created_at = ? AND id != ?))
            AND status != 'superseded'
          LIMIT 1`,
    ).bind(job.email_id, job.operation, job.created_at, job.created_at, job.id).first();

    if (requestedStatus === "retry") {
        if (newer) {
            await c.env.DB.prepare(
                `UPDATE mail_mutation_jobs
                    SET status = 'superseded', last_error = ?, lease_token = NULL,
                        lease_until = NULL, completed_at = ?, updated_at = ?
                  WHERE id = ?`,
            ).bind(error, now, now, job.id).run();
            return c.json({ ok: true, status: "superseded" });
        }
        if (job.attempts >= MAX_ATTEMPTS) {
            await c.env.DB.prepare(
                `UPDATE mail_mutation_jobs
                    SET status = 'failed', last_error = ?, lease_token = NULL,
                        lease_until = NULL, completed_at = ?, updated_at = ?
                  WHERE id = ?`,
            ).bind(error || "retry limit exceeded", now, now, job.id).run();
            return c.json({ ok: true, status: "failed" });
        }
        const requestedDelay = Number(body.retry_after_ms ?? 5000 * (2 ** Math.max(0, job.attempts - 1)));
        const retryAfter = Number.isFinite(requestedDelay)
            ? Math.max(1000, Math.min(MAX_RETRY_MS, Math.trunc(requestedDelay)))
            : 5000;
        await c.env.DB.prepare(
            `UPDATE mail_mutation_jobs
                SET status = 'pending', next_attempt_at = ?, last_error = ?,
                    lease_token = NULL, lease_until = NULL, updated_at = ?
              WHERE id = ?`,
        ).bind(now + retryAfter, error, now, job.id).run();
        return c.json({ ok: true, status: "pending", retry_at: now + retryAfter });
    }

    const terminal = requestedStatus as "succeeded" | "failed" | "unsupported";
    await c.env.DB.prepare(
        `UPDATE mail_mutation_jobs
            SET status = ?, last_error = ?, lease_token = NULL, lease_until = NULL,
                completed_at = ?, updated_at = ?
          WHERE id = ?`,
    ).bind(terminal, error, now, now, job.id).run();

    // Only the newest intent is allowed to change the local projection. An
    // older provider write may finish successfully after a newer request was
    // queued; the newer job will converge the source and local row afterwards.
    if (terminal === "succeeded" && !newer) {
        const column = job.operation === "set_read" ? "is_read" : "is_starred";
        await c.env.DB.prepare(`UPDATE emails SET ${column} = ?, updated_at = ? WHERE id = ?`)
            .bind(job.desired_value ? 1 : 0, now, job.email_id).run();
    }

    return c.json({ ok: true, status: terminal });
};
