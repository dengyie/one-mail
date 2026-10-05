import assert from 'node:assert/strict';
import test from 'node:test';
import statistics from '../admin_api/statistics_api.ts';
import { QuotaTelemetryError, resetD1QuotaStateForTests, recordD1Quota } from './d1_quota.ts';

const now = Date.UTC(2026, 9, 5, 12);
const context = (kv) => ({
    env: { KV: kv, DB: { prepare() { throw new Error('D1 daily read quota exhausted'); } } },
    json: (value) => Response.json(value),
});

test('admin quota endpoint remains available without any D1 reads', async () => {
    resetD1QuotaStateForTests({ now: () => now });
    recordD1Quota({ rows_read: 123, rows_written: 4 });
    const response = await statistics.getD1Quota(context({ get: async () => null }));
    assert.equal(response.status, 200);
    const { d1Quota } = await response.json();
    assert.equal(d1Quota.utc_date, '2026-10-05');
    assert.equal(d1Quota.rows_read, 123);
    assert.equal(d1Quota.rows_written, 4);
});

test('admin quota endpoint propagates a KV outage with the original cause', async () => {
    resetD1QuotaStateForTests({ now: () => now });
    const cause = new Error('KV unavailable');
    await assert.rejects(statistics.getD1Quota(context({ get: async () => { throw cause; } })), (error) => {
        assert.ok(error instanceof QuotaTelemetryError);
        assert.equal(error.cause, cause);
        return true;
    });
});
