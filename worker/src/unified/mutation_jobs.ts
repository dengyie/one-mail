import type { Context } from "hono";

import { checkRowAccess } from "./auth_scope.ts";
import { resolveMoveTarget, type UnifiedFolderRow } from "./folders.ts";

export type MailMutationOperation = "set_read" | "set_starred" | "move" | "delete";
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
    message_id_header: string | null;
};

type MutationJobRow = {
    id: string;
    email_id: string;
    account_id: string;
    source: string | null;
    to_addr: string | null;
    provider: string;
    operation: MailMutationOperation;
    desired_value: number | null;
    source_folder: string | null;
    source_folder_id: string | null;
    target_folder: string | null;
    target_folder_id: string | null;
    provider_message_id: string | null;
    source_key: string | null;
    message_id_header: string | null;
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

type MutationProjection = {
    source_folder?: unknown;
    source_folder_id?: unknown;
    source_key?: unknown;
    provider_message_id?: unknown;
};

const mutationEmailSelect = `SELECT id, source, account_id, to_addr, is_read, is_starred,
    provider, source_folder, source_folder_id, provider_message_id, source_key, imap_uid,
    message_id_header
    FROM emails WHERE id = ?`;

const isLocationOperation = (operation: MailMutationOperation): boolean =>
    operation === "move" || operation === "delete";

const boundedText = (value: unknown, max = 2048): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > max) return null;
    return trimmed;
};

const loadMutableEmail = async (c: Context<HonoCustomType>): Promise<MutableEmailRow | null> =>
    await c.env.DB.prepare(mutationEmailSelect).bind(c.req.param("id")).first<MutableEmailRow>();

const unsupportedResponse = (
    c: Context<HonoCustomType>,
    support: { provider: string; code: string },
    operation: MailMutationOperation,
) => c.json({
    error: "provider mutation unsupported",
    status: "unsupported",
    code: support.code,
    provider: support.provider,
    operation,
}, 409);

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
    operation: "set_read" | "set_starred",
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

const supersedeOlderPendingIntent = async (
    c: Context<HonoCustomType>,
    row: MutableEmailRow,
    operation: MailMutationOperation,
    id: string,
    now: number,
) => {
    if (isLocationOperation(operation)) {
        await c.env.DB.prepare(
            `UPDATE mail_mutation_jobs
                SET status = 'superseded', completed_at = ?, updated_at = ?
              WHERE email_id = ? AND operation IN ('move', 'delete') AND status = 'pending'
                AND id != ?
                AND rowid < (SELECT rowid FROM mail_mutation_jobs WHERE id = ?)`,
        ).bind(now, now, row.id, id, id).run();
        return;
    }
    await c.env.DB.prepare(
        `UPDATE mail_mutation_jobs
            SET status = 'superseded', completed_at = ?, updated_at = ?
          WHERE email_id = ? AND operation = ? AND status = 'pending'
            AND id != ?
            AND rowid < (SELECT rowid FROM mail_mutation_jobs WHERE id = ?)`,
    ).bind(now, now, row.id, operation, id, id).run();
};

const queueExternalMutation = async (
    c: Context<HonoCustomType>,
    row: MutableEmailRow,
    provider: "imap" | "graph",
    operation: MailMutationOperation,
    desired: number | null,
    target?: UnifiedFolderRow | null,
) => {
    const now = Date.now();
    const id = crypto.randomUUID();

    await c.env.DB.prepare(
        `INSERT INTO mail_mutation_jobs (
            id, email_id, account_id, source, to_addr, provider, operation, desired_value,
            source_folder, source_folder_id, target_folder, target_folder_id,
            provider_message_id, source_key, message_id_header,
            status, attempts, next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?)`,
    ).bind(
        id,
        row.id,
        row.account_id,
        row.source,
        row.to_addr,
        provider,
        operation,
        desired,
        row.source_folder,
        row.source_folder_id,
        target?.canonical_name ?? null,
        target?.provider_folder_id ?? null,
        row.provider_message_id,
        row.source_key || row.imap_uid,
        row.message_id_header,
        now,
        now,
    ).run();

    // Desired-state intents collapse while still pending. Location-changing
    // intents share one group: a newer delete supersedes a pending move and a
    // newer move supersedes an earlier move/delete that has not started yet.
    await supersedeOlderPendingIntent(c, row, operation, id, now);

    return c.json({
        ok: true,
        status: "queued",
        job_id: id,
        operation,
        desired_value: desired,
        ...(target ? {
            target_folder: target.canonical_name,
            target_folder_id: target.provider_folder_id,
        } : {}),
    }, 202);
};

const mutateMessageState = async (
    c: Context<HonoCustomType>,
    operation: "set_read" | "set_starred",
    explicitDesired?: number,
) => {
    const row = await loadMutableEmail(c);
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
    if (!support.ok) return unsupportedResponse(c, support, operation);
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

export const moveEmail = async (c: Context<HonoCustomType>) => {
    const row = await loadMutableEmail(c);
    if (!row) return c.json({ error: "not found" }, 404);
    if (!(await checkRowAccess(c, row))) return c.json({ error: "forbidden" }, 403);

    const support = providerMutationSupport(row);
    if (!support.ok) return unsupportedResponse(c, support, "move");
    if (support.provider === "native") {
        return c.json({
            error: "provider mutation unsupported",
            status: "unsupported",
            code: "native_folder_move_unsupported",
            provider: "native",
            operation: "move",
        }, 409);
    }

    const body = await c.req.json<{ folder_id?: number | string }>().catch(() => ({}));
    const folderId = Number(body.folder_id);
    if (!Number.isSafeInteger(folderId) || folderId <= 0 || !row.account_id) {
        return c.json({ error: "valid folder_id required" }, 400);
    }
    const target = await resolveMoveTarget(c, row.account_id, support.provider, folderId);
    if (!target) return c.json({ error: "target folder not found for this mail account" }, 400);

    const sameFolder = target.provider_folder_id && row.source_folder_id
        ? target.provider_folder_id === row.source_folder_id
        : target.canonical_name === row.source_folder;
    if (sameFolder) {
        return c.json({
            ok: true,
            status: "succeeded",
            operation: "move",
            source_folder: row.source_folder,
            source_folder_id: row.source_folder_id,
        });
    }
    return queueExternalMutation(c, row, support.provider, "move", null, target);
};

export const deleteEmail = async (c: Context<HonoCustomType>) => {
    const row = await loadMutableEmail(c);
    if (!row) return c.json({ error: "not found" }, 404);
    if (!(await checkRowAccess(c, row))) return c.json({ error: "forbidden" }, 403);

    const support = providerMutationSupport(row);
    if (!support.ok) return unsupportedResponse(c, support, "delete");
    if (support.provider === "native") {
        await c.env.DB.prepare(`DELETE FROM emails WHERE id = ?`).bind(row.id).run();
        return c.json({ ok: true, status: "succeeded", operation: "delete", deleted: true });
    }
    return queueExternalMutation(c, row, support.provider, "delete", null);
};

const canReadMutationJob = async (c: Context<HonoCustomType>, job: MutationJobRow): Promise<boolean> => {
    const row = await c.env.DB.prepare(
        `SELECT source, account_id, to_addr FROM emails WHERE id = ?`,
    ).bind(job.email_id).first<{ source?: string | null; account_id?: string | null; to_addr?: string | null }>();
    if (row) return checkRowAccess(c, row);
    // A successful delete intentionally removes the emails row. Authorization
    // must remain available through the immutable ownership snapshot on the job
    // so the client can observe the final succeeded state instead of a false 404.
    return checkRowAccess(c, {
        source: job.source,
        account_id: job.account_id,
        to_addr: job.to_addr,
    });
};

export const getMutationStatus = async (c: Context<HonoCustomType>) => {
    const job = await c.env.DB.prepare(
        `SELECT id, email_id, account_id, source, to_addr, provider, operation,
                desired_value, source_folder, source_folder_id, target_folder,
                target_folder_id, provider_message_id, source_key, message_id_header,
                status, attempts, last_error, created_at, updated_at, completed_at
           FROM mail_mutation_jobs WHERE id = ?`,
    ).bind(c.req.param("id")).first<MutationJobRow>();
    if (!job) return c.json({ error: "not found" }, 404);
    if (!(await canReadMutationJob(c, job))) return c.json({ error: "forbidden" }, 403);

    return c.json({
        id: job.id,
        email_id: job.email_id,
        operation: job.operation,
        desired_value: job.desired_value,
        target_folder: job.target_folder,
        target_folder_id: job.target_folder_id,
        status: job.status,
        attempts: job.attempts,
        error: job.last_error,
        created_at: job.created_at,
        updated_at: job.updated_at,
        completed_at: job.completed_at,
    });
};

const collapseDuplicatePendingIntents = async (c: Context<HonoCustomType>, now: number) => {
    // Defensive repair for racing/legacy duplicate desired-state intents.
    await c.env.DB.prepare(
        `UPDATE mail_mutation_jobs AS current
            SET status = 'superseded', completed_at = ?, updated_at = ?
          WHERE current.status = 'pending'
            AND current.operation IN ('set_read', 'set_starred')
            AND EXISTS (
                SELECT 1 FROM mail_mutation_jobs newer
                 WHERE newer.email_id = current.email_id
                   AND newer.operation = current.operation
                   AND newer.status = 'pending'
                   AND newer.rowid > current.rowid
            )`,
    ).bind(now, now).run();
    await c.env.DB.prepare(
        `UPDATE mail_mutation_jobs AS current
            SET status = 'superseded', completed_at = ?, updated_at = ?
          WHERE current.status = 'pending'
            AND current.operation IN ('move', 'delete')
            AND EXISTS (
                SELECT 1 FROM mail_mutation_jobs newer
                 WHERE newer.email_id = current.email_id
                   AND newer.operation IN ('move', 'delete')
                   AND newer.status = 'pending'
                   AND newer.rowid > current.rowid
            )`,
    ).bind(now, now).run();
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

    // Recover crashed workers. Desired-state operations can be retried. Move and
    // delete adapters must also implement absence/same-destination recovery.
    await c.env.DB.prepare(
        `UPDATE mail_mutation_jobs
            SET status = 'pending', lease_token = NULL, lease_until = NULL, updated_at = ?
          WHERE status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?`,
    ).bind(now, now).run();
    await collapseDuplicatePendingIntents(c, now);

    // Only one job per email may be processing. A move can replace an IMAP UID;
    // later read/star/delete jobs must not leave the Worker in the same claim
    // batch with the old identity. They are claimed after move result projection
    // rewrites their pending identity snapshot.
    const { results } = await c.env.DB.prepare(
        `SELECT id, email_id, operation FROM mail_mutation_jobs j
          WHERE j.status = 'pending'
            AND j.next_attempt_at <= ?
            AND NOT EXISTS (
                SELECT 1 FROM mail_mutation_jobs p
                 WHERE p.email_id = j.email_id AND p.status = 'processing'
            )
            AND NOT EXISTS (
                SELECT 1 FROM mail_mutation_jobs earlier
                 WHERE earlier.email_id = j.email_id
                   AND earlier.status = 'pending'
                   AND earlier.rowid < j.rowid
            )
          ORDER BY j.created_at ASC, j.rowid ASC
          LIMIT ?`,
    ).bind(now, requested).all<{ id: string; email_id: string; operation: MailMutationOperation }>();

    for (const candidate of results || []) {
        await c.env.DB.prepare(
            `UPDATE mail_mutation_jobs
                SET status = 'processing', attempts = attempts + 1,
                    lease_token = ?, lease_until = ?, updated_at = ?
              WHERE id = ? AND status = 'pending' AND next_attempt_at <= ?
                AND NOT EXISTS (
                    SELECT 1 FROM mail_mutation_jobs p
                     WHERE p.email_id = ? AND p.status = 'processing'
                )`,
        ).bind(leaseToken, leaseUntil, now, candidate.id, now, candidate.email_id).run();
    }

    const claimed = await c.env.DB.prepare(
        `SELECT id, email_id, account_id, source, to_addr, provider, operation, desired_value,
                source_folder, source_folder_id, target_folder, target_folder_id,
                provider_message_id, source_key, message_id_header,
                status, attempts, lease_token, lease_until, created_at
           FROM mail_mutation_jobs
          WHERE status = 'processing' AND lease_token = ?
          ORDER BY created_at ASC, rowid ASC`,
    ).bind(leaseToken).all<MutationJobRow>();

    return c.json({ jobs: claimed.results || [], lease_until: leaseUntil });
};

const newerIntentExists = async (c: Context<HonoCustomType>, job: MutationJobRow): Promise<boolean> => {
    const operationWhere = isLocationOperation(job.operation)
        ? `newer.operation IN ('move', 'delete')`
        : `newer.operation = ?`;
    const params = isLocationOperation(job.operation)
        ? [job.email_id, job.id]
        : [job.email_id, job.operation, job.id];
    const newer = await c.env.DB.prepare(
        `SELECT 1 FROM mail_mutation_jobs newer
          WHERE newer.email_id = ? AND ${operationWhere}
            AND newer.rowid > (SELECT rowid FROM mail_mutation_jobs WHERE id = ?)
            AND newer.status != 'superseded'
          LIMIT 1`,
    ).bind(...params).first();
    return !!newer;
};

const terminalJobStatement = (
    c: Context<HonoCustomType>,
    job: MutationJobRow,
    terminal: "succeeded" | "failed" | "unsupported",
    error: string | null,
    now: number,
) => c.env.DB.prepare(
    `UPDATE mail_mutation_jobs
        SET status = ?, last_error = ?, lease_token = NULL, lease_until = NULL,
            completed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'processing'`,
).bind(terminal, error, now, now, job.id);

const normalizedMoveProjection = (
    job: MutationJobRow,
    projection: MutationProjection | undefined,
): { sourceFolder: string; sourceFolderId: string | null; sourceKey: string | null; providerMessageId: string | null } | null => {
    const sourceFolder = boundedText(projection?.source_folder, 1024);
    if (!sourceFolder || !job.target_folder || sourceFolder !== job.target_folder) return null;

    const rawFolderId = projection?.source_folder_id;
    const sourceFolderId = rawFolderId === null
        ? null
        : boundedText(rawFolderId, 2048) ?? job.target_folder_id;
    const sourceKey = boundedText(projection?.source_key, 4096) ?? job.source_key;
    const providerMessageId = boundedText(projection?.provider_message_id, 4096) ?? job.provider_message_id;

    if (job.provider === "imap" && !sourceKey) return null;
    // Graph ImmutableId is deliberately stable across folder moves. Accepting a
    // changed provider_message_id would silently fork the uniqueness contract.
    if (job.provider === "graph" && job.provider_message_id && providerMessageId !== job.provider_message_id) {
        return null;
    }
    return { sourceFolder, sourceFolderId, sourceKey, providerMessageId };
};

export const reportMutationResult = async (c: Context<HonoCustomType>) => {
    const body = await c.req.json<{
        lease_token?: string;
        status?: "succeeded" | "retry" | "failed" | "unsupported";
        error?: string;
        retry_after_ms?: number;
        projection?: MutationProjection;
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
    const newer = await newerIntentExists(c, job);

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
    if (terminal !== "succeeded") {
        await terminalJobStatement(c, job, terminal, error, now).run();
        return c.json({ ok: true, status: terminal });
    }

    if (job.operation === "move") {
        const projection = normalizedMoveProjection(job, body.projection);
        if (!projection) return c.json({ error: "invalid move projection" }, 400);
        const statements = [
            terminalJobStatement(c, job, "succeeded", error, now),
            c.env.DB.prepare(
                `UPDATE emails
                    SET source_folder = ?, source_folder_id = ?, source_key = ?,
                        provider_message_id = ?,
                        imap_uid = CASE WHEN provider = 'imap' THEN ? ELSE imap_uid END,
                        updated_at = ?
                  WHERE id = ?`,
            ).bind(
                projection.sourceFolder,
                projection.sourceFolderId,
                projection.sourceKey,
                projection.providerMessageId,
                projection.sourceKey,
                now,
                job.email_id,
            ),
            // Because claim is serialized per email, all later jobs are still
            // pending here. Rewrite their provider identity before any can lease.
            c.env.DB.prepare(
                `UPDATE mail_mutation_jobs
                    SET source_folder = ?, source_folder_id = ?, source_key = ?,
                        provider_message_id = ?, updated_at = ?
                  WHERE email_id = ? AND status = 'pending'
                    AND rowid > (SELECT rowid FROM mail_mutation_jobs WHERE id = ?)`,
            ).bind(
                projection.sourceFolder,
                projection.sourceFolderId,
                projection.sourceKey,
                projection.providerMessageId,
                now,
                job.email_id,
                job.id,
            ),
        ];
        await c.env.DB.batch(statements);
        return c.json({
            ok: true,
            status: "succeeded",
            source_folder: projection.sourceFolder,
            source_folder_id: projection.sourceFolderId,
        });
    }

    if (job.operation === "delete") {
        await c.env.DB.batch([
            terminalJobStatement(c, job, "succeeded", error, now),
            c.env.DB.prepare(
                `UPDATE mail_mutation_jobs
                    SET status = 'superseded', completed_at = ?, updated_at = ?,
                        last_error = COALESCE(last_error, 'message deleted by earlier provider mutation')
                  WHERE email_id = ? AND status = 'pending'
                    AND rowid > (SELECT rowid FROM mail_mutation_jobs WHERE id = ?)`,
            ).bind(now, now, job.email_id, job.id),
            c.env.DB.prepare(`DELETE FROM emails WHERE id = ?`).bind(job.email_id),
        ]);
        return c.json({ ok: true, status: "succeeded", deleted: true });
    }

    // Read/star desired-state projection stays newest-intent-only. If a newer
    // same-operation request exists, provider completion is recorded but the
    // newer intent owns the visible local state.
    const statements = [terminalJobStatement(c, job, "succeeded", error, now)];
    if (!newer) {
        const column = job.operation === "set_read" ? "is_read" : "is_starred";
        statements.push(
            c.env.DB.prepare(`UPDATE emails SET ${column} = ?, updated_at = ? WHERE id = ?`)
                .bind(job.desired_value ? 1 : 0, now, job.email_id),
        );
    }
    await c.env.DB.batch(statements);
    return c.json({ ok: true, status: "succeeded" });
};