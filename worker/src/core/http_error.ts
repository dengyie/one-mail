import type { Context } from 'hono';
import { resolveCorsOrigin } from '../cors_policy.ts';
import { serializeError } from './error_serialization.ts';
import { d1DailyQuotaFailure } from './d1_errors.ts';
import { D1HourlyReadBudgetError } from './d1_quota.ts';

const withQuotaHeaders = (c: Context<HonoCustomType>, body: unknown, retryAfterSeconds: number): Response => {
    const response = c.json(body, 503);
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Retry-After', String(retryAfterSeconds));
    const allowOrigin = resolveCorsOrigin(c.req.raw.headers.get('Origin') ?? '', c.env.FRONTEND_URL);
    if (allowOrigin) {
        response.headers.set('Access-Control-Allow-Origin', allowOrigin);
        response.headers.append('Vary', 'Origin');
    }
    return response;
};

/** HTTP entrypoint: retain the internal cause once and expose only safe errors. */
export const handleApiError = (error: Error, c: Context<HonoCustomType>): Response => {
    console.error('Worker request failed', {
        method: c.req.method,
        path: c.req.path,
        error: serializeError(error),
    });
    if (error instanceof D1HourlyReadBudgetError) {
        const retryAfterSeconds = Math.max(1, Math.ceil((Date.parse(error.retryAt) - Date.now()) / 1000));
        return withQuotaHeaders(c, {
            error: error.message,
            code: error.code,
            retry_at: error.retryAt,
        }, retryAfterSeconds);
    }
    const quota = d1DailyQuotaFailure(error, Date.now());
    const response = quota
        ? withQuotaHeaders(c, quota.body, quota.retryAfterSeconds)
        : c.json({ error: 'Internal server error' }, 500);
    if (!quota) response.headers.set('Cache-Control', 'no-store');
    return response;
};
