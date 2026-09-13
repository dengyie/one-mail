import type { Context } from "hono";

const MAX_CLAIM = 50;
const LEASE_MS = 60_000;

/**
 * Rolling-deploy compatibility endpoint for pre-move/delete aggregators.
 *
 * Older agents call /admin/unified/mutations/claim and do not understand the
 * new operations. Never hand them move/delete work: it would be reported as
 * unsupported before the v2 aggregator reaches the host. The v2 endpoint uses
 * the full claimMutationJobs implementation.
 */
export const claimLegacyMutationJobs = async (c: Context<HonoCustomType>) => {
    const body = await c.req.json<{ lease_token?: string; limit?: number }>().catch(() => ({}));
    const leaseToken = typeof body.lease_token === "string" ? body.lease_token.trim() : "";
    const requested = Number(body.limit ?? 20);
    if (!leaseToken || leaseToken.length > 200 || !Number.isInteger(requested) || requested < 1 || requested > MAX_CLAIM) {
        return c.json({ error: "invalid claim request" }, 400);
    }

    const now = Date.now();
    const leaseUntil = now + LEASE_MS;

    // Recover expired leases for every operation. New operations remain pending
    // but are intentionally invisible to this legacy endpoint.
    await c.env.DB.prepare(
        `UPDATE mail_mutation_jobs
            SET status = 'pending', lease_token = NULL, lease_until = NULL, updated_at = ?
          WHERE status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?`,
    ).bind(now, now).run();

    // Defensive collapse of old duplicate desired-state rows.
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

    const { results } = await c.env.DB.prepare(
        `SELECT id, email_id FROM mail_mutation_jobs j
          WHERE j.status = 'pending'
            AND j.operation IN ('set_read', 'set_starred')
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
    ).bind(now, requested).all<{ id: string; email_id: string }>();

    for (const candidate of results || []) {
        await c.env.DB.prepare(
            `UPDATE mail_mutation_jobs
                SET status = 'processing', attempts = attempts + 1,
                    lease_token = ?, lease_until = ?, updated_at = ?
              WHERE id = ? AND status = 'pending' AND next_attempt_at <= ?
                AND operation IN ('set_read', 'set_starred')
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
            AND operation IN ('set_read', 'set_starred')
          ORDER BY created_at ASC, rowid ASC`,
    ).bind(leaseToken).all();

    return c.json({ jobs: claimed.results || [], lease_until: leaseUntil, claim_version: 1 });
};
