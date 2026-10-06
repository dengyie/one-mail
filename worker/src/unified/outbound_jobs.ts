import type { Context } from "hono";

import type { OutboundJobRow, OutboundStatus } from "../core/outbound_mail.ts";
import { isOutboundStatus } from "../core/outbound_mail.ts";

const MAX_CLAIM = 50;
const LEASE_MS = 60_000;
const MAX_RETRY_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;

type ClaimBody = { lease_token?: string; limit?: number };
type ReportBody = {
    lease_token?: string;
    status?: string;
    error?: string;
    retry_after_ms?: number;
    provider_message_id?: string;
};

const changesOf = (result: D1Result<unknown> | undefined): number =>
    Number((result?.meta as { changes?: number } | undefined)?.changes ?? 0);

const staleLeaseResponse = (c: Context<HonoCustomType>) =>
    c.json({ error: "stale or unknown lease" }, 409);

/**
 * POST /admin/unified/outbound/claim
 *
 * Leases up to MAX_CLAIM pending outbound mail jobs for one aggregator worker.
 * Expired leases (processing beyond their lease_until) are reclaimed before
 * new jobs are assigned. Jobs are independent — no per-email serialization is
 * required because outbound sends don't affect the emails table.
 */
export const claimOutboundJobs = async (c: Context<HonoCustomType>) => {
    const body = await c.req.json<ClaimBody>().catch((): ClaimBody => ({}));
    const leaseToken = typeof body.lease_token === "string" ? body.lease_token.trim() : "";
    const requested = Number(body.limit ?? 20);
    if (!leaseToken || leaseToken.length > 200 || !Number.isInteger(requested) || requested < 1 || requested > MAX_CLAIM) {
        return c.json({ error: "invalid claim request" }, 400);
    }

    const now = Date.now();
    const leaseUntil = now + LEASE_MS;

    // Recover jobs whose previous claimant died or timed out.
    await c.env.DB.prepare(
        `UPDATE outbound_mail_jobs
            SET status = 'pending', lease_token = NULL, lease_until = NULL, updated_at = ?
          WHERE status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?`,
    ).bind(now, now).run();

    // Claim ready jobs in FIFO order. The UPDATE re-checks `status = 'pending'`
    // so a stale candidate cannot be double-leased.
    const { results } = await c.env.DB.prepare(
        `SELECT id FROM outbound_mail_jobs
          WHERE status = 'pending'
            AND next_attempt_at <= ?
          ORDER BY created_at ASC, rowid ASC
          LIMIT ?`,
    ).bind(now, requested).all<{ id: string }>();

    for (const candidate of results || []) {
        await c.env.DB.prepare(
            `UPDATE outbound_mail_jobs
                SET status = 'processing', attempts = attempts + 1,
                    lease_token = ?, lease_until = ?, updated_at = ?
              WHERE id = ? AND status = 'pending' AND next_attempt_at <= ?`,
        ).bind(leaseToken, leaseUntil, now, candidate.id, now).run();
    }

    const claimed = await c.env.DB.prepare(
        `SELECT id, account_id, from_addr, to_addr, subject,
                body_text, body_html, payload_json, request_hash, provider,
                status, attempts, lease_token, lease_until, created_at
           FROM outbound_mail_jobs
          WHERE status = 'processing' AND lease_token = ?
          ORDER BY created_at ASC, rowid ASC`,
    ).bind(leaseToken).all<Pick<OutboundJobRow,
        "id" | "account_id" | "from_addr" | "to_addr" | "subject" |
        "body_text" | "body_html" | "payload_json" | "request_hash" |
        "provider" | "status" | "attempts" | "lease_token" | "lease_until" |
        "created_at"
    >>();

    return c.json({ jobs: claimed.results || [], lease_until: leaseUntil });
};

/**
 * POST /admin/unified/outbound/:id/result
 *
 * Reports the outcome of an outbound send attempt. The caller must present a
 * valid, non-expired lease_token for the job id. Terminal outcomes are final.
 * A retry resets the job to pending with capped exponential backoff; after the
 * bounded attempt budget is exhausted, the job becomes terminal `failed` so a
 * stuck provider cannot loop forever. (The aggregator reconciles the provider's
 * Sent folder before reporting retry, so a message is never double-sent.)
 */
export const reportOutboundResult = async (c: Context<HonoCustomType>) => {
    const body = await c.req.json<ReportBody>().catch((): ReportBody => ({}));
    const leaseToken = typeof body.lease_token === "string" ? body.lease_token.trim() : "";
    const requestedStatus = body.status;
    const terminalStatuses = new Set(["succeeded", "failed", "unsupported"]);
    if (!leaseToken || (!terminalStatuses.has(String(requestedStatus)) && requestedStatus !== "retry")) {
        return c.json({ error: "invalid outbound result" }, 400);
    }

    // Lease must still be live at read time; expiry is part of the fence.
    const claimNow = Date.now();
    const job = await c.env.DB.prepare(
        `SELECT id, attempts FROM outbound_mail_jobs
          WHERE id = ? AND status = 'processing' AND lease_token = ?
            AND lease_until IS NOT NULL AND lease_until > ?`,
    ).bind(c.req.param("id"), leaseToken, claimNow).first<Pick<OutboundJobRow, "id" | "attempts">>();
    if (!job) return staleLeaseResponse(c);

    const error = body.error ? String(body.error).slice(0, 1000) : null;
    const now = Date.now();

    if (requestedStatus === "retry") {
        // A definite provider "not sent" can be retried; after the bounded budget
        // it must fail terminally rather than loop. attempts was already
        // incremented at claim time, so the budget is attempts >= MAX_ATTEMPTS.
        if (job.attempts >= MAX_ATTEMPTS) {
            const result = await c.env.DB.prepare(
                `UPDATE outbound_mail_jobs
                    SET status = 'failed', last_error = ?, lease_token = NULL,
                        lease_until = NULL, completed_at = ?, updated_at = ?
                  WHERE id = ? AND status = 'processing' AND lease_token = ?
                    AND lease_until IS NOT NULL AND lease_until > ?`,
            ).bind(error || "retry limit exceeded", now, now, job.id, leaseToken, now).run();
            if (changesOf(result) !== 1) return staleLeaseResponse(c);
            return c.json({ ok: true, status: "failed" });
        }

        const requestedDelay = Number(body.retry_after_ms ?? 5000 * (2 ** Math.max(0, job.attempts - 1)));
        const retryAfter = Number.isFinite(requestedDelay)
            ? Math.max(1000, Math.min(MAX_RETRY_MS, Math.trunc(requestedDelay)))
            : 5000;
        const result = await c.env.DB.prepare(
            `UPDATE outbound_mail_jobs
                SET status = 'pending', next_attempt_at = ?, last_error = ?,
                    lease_token = NULL, lease_until = NULL, updated_at = ?
              WHERE id = ? AND status = 'processing' AND lease_token = ?
                AND lease_until IS NOT NULL AND lease_until > ?`,
        ).bind(now + retryAfter, error, now, job.id, leaseToken, now).run();
        if (changesOf(result) !== 1) return staleLeaseResponse(c);
        return c.json({ ok: true, status: "pending", retry_at: now + retryAfter });
    }

    const terminal = requestedStatus as OutboundStatus;
    if (!isOutboundStatus(terminal)) {
        return c.json({ error: "invalid outbound result status" }, 400);
    }

    const providerMessageId = typeof body.provider_message_id === "string"
        ? body.provider_message_id.trim().slice(0, 256)
        : null;

    const result = await c.env.DB.prepare(
        `UPDATE outbound_mail_jobs
            SET status = ?, last_error = ?, provider_message_id = ?,
                lease_token = NULL, lease_until = NULL,
                completed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'processing' AND lease_token = ?
            AND lease_until IS NOT NULL AND lease_until > ?`,
    ).bind(terminal, error, providerMessageId, now, now, job.id, leaseToken, now).run();
    if (changesOf(result) !== 1) return staleLeaseResponse(c);

    return c.json({ ok: true, status: terminal });
};