import { Context } from 'hono'
import { d1QuotaByShard } from '../unified/quota_report.ts'

const get = async (c: Context<HonoCustomType>) => {
    const { count: mailCount } = await c.env.DB.prepare(
        `SELECT count(*) as count FROM raw_mails`
    ).first<{ count: number }>() || {};
    const { count: addressCount } = await c.env.DB.prepare(
        `SELECT count(*) as count FROM address`
    ).first<{ count: number }>() || {};
    const { count: activeAddressCount7days } = await c.env.DB.prepare(
        `SELECT count(*) as count FROM address where updated_at > datetime('now', '-7 day')`
    ).first<{ count: number }>() || {};
    const { count: activeAddressCount30days } = await c.env.DB.prepare(
        `SELECT count(*) as count FROM address where updated_at > datetime('now', '-30 day')`
    ).first<{ count: number }>() || {};
    const { count: sendMailCount } = await c.env.DB.prepare(
        `SELECT count(*) as count FROM sendbox`
    ).first<{ count: number }>() || {};
    const { count: userCount } = await c.env.DB.prepare(
        `SELECT count(*) as count FROM users`
    ).first<{ count: number }>() || {};
    const d1Quotas = await d1QuotaByShard(c);
    return c.json({
        mailCount,
        addressCount,
        activeAddressCount7days,
        activeAddressCount30days,
        userCount,
        sendMailCount,
        // Single object retained for older clients; d1Quotas is the full
        // per-database breakdown (primary first).
        d1Quota: d1Quotas[0] ?? null,
        d1Quotas,
    });
};

const getD1Quota = async (c: Context<HonoCustomType>): Promise<Response> => {
    const d1Quotas = await d1QuotaByShard(c);
    return c.json({ d1Quota: d1Quotas[0] ?? null, d1Quotas });
};

export default { get, getD1Quota };
