import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { handleApiError } from './http_error.ts';
import { d1DailyQuotaFailure } from './d1_errors.ts';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const origin = 'https://inbox.example.test';

async function fail(t, error) {
    t.mock.method(console, 'error', () => {});
    t.mock.method(Date, 'now', () => NOW);
    const app = new Hono();
    app.onError(handleApiError);
    app.get('/test', () => { throw error; });
    return app.request('https://api.example.test/test', { headers: { Origin: origin } }, { FRONTEND_URL: origin });
}

for (const kind of ['read', 'write']) {
    test(`D1 daily ${kind} exhaustion returns an explicit UTC retry deadline and keeps CORS`, async t => {
        const cause = new Error(`D1_ERROR: Your account has exceeded D1's free tier daily row ${kind} limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.`);
        const response = await fail(t, new Error('wrapped operation', { cause }));
        assert.equal(response.status, 503);
        assert.equal(response.headers.get('Retry-After'), '43200');
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
        const body = await response.json();
        assert.equal(body.code, `D1_DAILY_${kind.toUpperCase()}_LIMIT`);
        assert.equal(body.retry_at, '2026-10-09T00:00:00.000Z');
        assert.ok(!JSON.stringify(body).includes('stack'));
    });
}

test('other D1 failures remain errors and are not misclassified as daily quotas', async t => {
    const response = await fail(t, new Error('D1_ERROR: no such table: private_table'));
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('Retry-After'), null);
    assert.deepEqual(await response.json(), { error: 'Internal server error' });
});

test('daily quota deadlines use UTC boundaries and round Retry-After upwards', () => {
    const error = new Error("D1_ERROR: Your account has exceeded D1's free tier daily row write limit.");
    const reset = Date.parse('2026-10-09T00:00:00Z');
    assert.equal(d1DailyQuotaFailure(error, reset - 1).retryAfterSeconds, 1);
    assert.equal(d1DailyQuotaFailure(error, reset).retryAfterSeconds, 86400);
    assert.equal(d1DailyQuotaFailure(error, reset).body.retry_at, '2026-10-10T00:00:00.000Z');
});

test('cyclic and unrelated causes never become quota errors', () => {
    const error = new Error('unrelated');
    error.cause = error;
    assert.equal(d1DailyQuotaFailure(error, NOW), null);
    assert.equal(d1DailyQuotaFailure(null, NOW), null);
});
