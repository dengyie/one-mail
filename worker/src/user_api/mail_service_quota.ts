import { Context } from "hono";

import { commonGetUserRole } from "../common";
import { getMailServiceQuota } from "../quota.ts";

/**
 * Return the effective service quota from the same server-side policy used by
 * enforcement. Clients may use this for UX, but must never treat it as the
 * enforcement boundary.
 */
export const getMailServiceQuotaStatus = async (c: Context<HonoCustomType>) => {
    const payload = c.get("userPayload");
    if (!payload?.user_id) {
        return c.json({ error: "unauthorized" }, 401);
    }

    const userRole = (await commonGetUserRole(c, payload.user_id))?.role ?? null;
    const isAdmin = !!c.env.ADMIN_USER_ROLE && userRole === c.env.ADMIN_USER_ROLE;
    const quota = await getMailServiceQuota(c, userRole);
    const row = await c.env.DB.prepare(
        `SELECT COUNT(*) AS count FROM user_mail_accounts WHERE user_id = ?`
    ).bind(payload.user_id).first<{ count: number }>();

    return c.json({
        role: userRole,
        is_admin: isAdmin,
        quota,
        usage: {
            mailAccountCount: Number(row?.count ?? 0),
        },
    });
};

export default { getMailServiceQuotaStatus };
