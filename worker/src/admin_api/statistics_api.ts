import { Context } from 'hono'
import { d1QuotaByShard } from '../unified/quota_report.ts'

// Six independent COUNT(*) queries. Sending them as one batch() collapses six
// serial D1 round trips into a single one: this page is opened precisely when
// the daily D1 read quota is under pressure, so both latency and per-statement
// overhead matter. The quota wrapper records per-result deltas, so the telemetry
// accounting is identical to the previous sequential form.
const STATISTICS_COUNT_SQL = [
    `SELECT count(*) as count FROM raw_mails`,
    `SELECT count(*) as count FROM address`,
    `SELECT count(*) as count FROM address where updated_at > datetime('now', '-7 day')`,
    `SELECT count(*) as count FROM address where updated_at > datetime('now', '-30 day')`,
    `SELECT count(*) as count FROM sendbox`,
    `SELECT count(*) as count FROM users`,
] as const

const get = async (c: Context<HonoCustomType>) => {
    const results = await c.env.DB.batch<{ count: number }>(
        STATISTICS_COUNT_SQL.map((sql) => c.env.DB.prepare(sql)),
    );
    const [mailCount, addressCount, activeAddressCount7days, activeAddressCount30days, sendMailCount, userCount] =
        results.map((result) => result.results?.[0]?.count);
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
