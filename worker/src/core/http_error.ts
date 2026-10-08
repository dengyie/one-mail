import type { Context } from 'hono';
import { resolveCorsOrigin } from '../cors_policy.ts';
import { serializeError } from './error_serialization.ts';
import { d1DailyQuotaFailure } from './d1_errors.ts';

/** HTTP entrypoint: retain the internal cause once and expose only safe errors. */
export const handleApiError = (error: Error, c: Context<HonoCustomType>): Response => {
    console.error('Worker request failed', {
        method: c.req.method,
        path: c.req.path,
        error: serializeError(error),
    });
    const quota = d1DailyQuotaFailure(error, Date.now());
    const response = quota ? c.json(quota.body, 503) : c.json({ error: 'Internal server error' }, 500);
    response.headers.set('Cache-Control', 'no-store');
    if (quota) response.headers.set('Retry-After', String(quota.retryAfterSeconds));
    const allowOrigin = resolveCorsOrigin(c.req.raw.headers.get('Origin') ?? '', c.env.FRONTEND_URL);
    if (allowOrigin) {
        response.headers.set('Access-Control-Allow-Origin', allowOrigin);
        response.headers.append('Vary', 'Origin');
    }
    return response;
};
