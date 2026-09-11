import { Context } from "hono";

import { commonGetUserRole } from "../common";
import { getMailServiceQuota } from "../quota.ts";

/**
 * Return effective service quotas and current usage from the same server-side
 * policy used by enforcement. Clients may use this for UX; enforcement remains
 * exclusively server-side.
 */
export const getMailServiceQuotaStatus = async (c: Context<HonoCustomType>) => {
    const payload = c.get("userPayload");
    if (!payload?.user_id) {
        return c.json({ error: "unauthorized" }, 401);
    }

    const userRole = (await commonGetUserRole(c, payload.user_id))?.role ?? null;
    const isAdmin = !!c.env.ADMIN_USER_ROLE && userRole === c.env.ADMIN_USER_ROLE;
    const quota = await getMailServiceQuota(c, userRole);

    const mailAccounts = await c.env.DB.prepare(
        `SELECT COUNT(*) AS count FROM user_mail_accounts WHERE user_id = ?`
    ).bind(payload.user_id).first<{ count: number }>();
    const addresses = await c.env.DB.prepare(
        `SELECT COUNT(*) AS count FROM users_address ua
         JOIN address a ON a.id = ua.address_id
         WHERE ua.user_id = ? AND (a.source_meta IS NULL OR a.source_meta != 'external')`
    ).bind(payload.user_id).first<{ count: number }>();

    return c.json({
        role: userRole,
        is_admin: isAdmin,
        quota,
        usage: {
            addressCount: Number(addresses?.count ?? 0),
            mailAccountCount: Number(mailAccounts?.count ?? 0),
        },
    });
};

export default { getMailServiceQuotaStatus };
