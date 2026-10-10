import assert from 'node:assert/strict';
import test from 'node:test';
import statistics from './statistics_api.ts';
import { QuotaTelemetryError, resetD1QuotaStateForTests, recordD1Quota } from '../core/d1_quota.ts';
import { resetShardMapCacheForTests, SHARD_MAP_KV_KEY } from '../unified/shard_map.ts';
import { isD1QuotaView } from '../unified/quota_report.ts';

const now = Date.UTC(2026, 9, 5, 12);
// The DB handle throws on any use: these endpoints must stay servable while the
// daily D1 read quota is exhausted, so the whole path has to avoid D1 entirely.
const context = (kv) => ({
    env: { KV: kv, DB: { prepare() { throw new Error('D1 daily read quota exhausted'); } } },
    req: { raw: { signal: undefined } },
    json: (value) => Response.json(value),
});

const SHARD_TOKEN = 's'.repeat(32);
const shardMap = (overrides = {}) => JSON.stringify({
    v: 1,
    shards: [{ id: 'shard-b', base_url: 'https://shard-b.example.com', token: SHARD_TOKEN }],
    accounts: { 'acc-1': 'shard-b' },
    ...overrides,
});

const remoteQuota = {
    shard_id: 'shard-b', utc_date: '2026-10-05', rows_read: 50, rows_written: 7,
    rows_read_limit: 5_000_000, rows_written_limit: 100_000, rows_read_pct: 0, rows_written_pct: 0,
    pending_unflushed: { rows_read: 0, rows_written: 0 }, flushed_at: 1, flush_count: 1,
    aggregation_mode: 'best_effort_kv', confidence: 'partial', accounting_issues: [],
};

const kvWithMap = (map) => ({ get: async (key) => (key === SHARD_MAP_KV_KEY ? map : null) });

const withFetch = async (impl, run) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = impl;
    try { return await run(); } finally { globalThis.fetch = originalFetch; }
};

test('admin quota endpoint remains available without any D1 reads', async () => {
    resetD1QuotaStateForTests({ now: () => now });
    resetShardMapCacheForTests();
    recordD1Quota({ rows_read: 123, rows_written: 4 });
    const response = await statistics.getD1Quota(context({ get: async () => null }));
    assert.equal(response.status, 200);
    const { d1Quota, d1Quotas } = await response.json();
    assert.equal(d1Quota.utc_date, '2026-10-05');
    assert.equal(d1Quota.rows_read, 123);
    assert.equal(d1Quota.rows_written, 4);
    // legacy-static: an empty registry keeps the single-card shape.
    assert.equal(d1Quotas.length, 1);
    assert.equal(d1Quotas[0].shard_id, 'primary');
    assert.equal(d1Quotas[0].accounts_known, false);
    assert.equal(d1Quotas[0].reachable, true);
    assert.equal(d1Quotas[0].unavailable_reason, null);
});

test('admin quota endpoint propagates a KV outage with the original cause', async () => {
    resetD1QuotaStateForTests({ now: () => now });
    resetShardMapCacheForTests();
    const cause = new Error('KV unavailable');
    await assert.rejects(statistics.getD1Quota(context({ get: async () => { throw cause; } })), (error) => {
        assert.ok(error instanceof QuotaTelemetryError);
        assert.equal(error.cause, cause);
        return true;
    });
});

test('admin quota endpoint reports each registered shard without any D1 reads', async () => {
    resetD1QuotaStateForTests({ now: () => now });
    resetShardMapCacheForTests();
    recordD1Quota({ rows_read: 100, rows_written: 1 });
    const calls = [];
    await withFetch(async (url) => {
        calls.push(String(url));
        return Response.json(remoteQuota);
    }, async () => {
        const response = await statistics.getD1Quota(context(kvWithMap(shardMap())));
        const { d1Quota, d1Quotas } = await response.json();
        assert.equal(d1Quota.shard_id, 'primary');
        assert.equal(d1Quotas.length, 2);
        assert.equal(d1Quotas[1].shard_id, 'shard-b');
        assert.equal(d1Quotas[1].rows_read, 50);
        assert.equal(d1Quotas[1].reachable, true);
        assert.equal(d1Quotas[1].unavailable_reason, null);
        assert.equal(d1Quotas[1].accounts_known, true);
        assert.deepEqual(d1Quotas[1].account_ids, ['acc-1']);
        assert.equal(calls.length, 1);
        assert.ok(calls[0].startsWith('https://shard-b.example.com/shard/quota'));
    });
});

test('a registered shard that cannot be reached is reported, not dropped', async () => {
    resetD1QuotaStateForTests({ now: () => now });
    resetShardMapCacheForTests();
    await withFetch(async () => new Response('nope', { status: 502 }), async () => {
        const response = await statistics.getD1Quota(context(kvWithMap(shardMap())));
        const { d1Quotas } = await response.json();
        assert.equal(d1Quotas.length, 2);
        assert.equal(d1Quotas[1].shard_id, 'shard-b');
        assert.equal(d1Quotas[1].reachable, false);
        // The transport reason must survive, so the card is diagnosable.
        assert.equal(d1Quotas[1].unavailable_reason, 'http_502');
        assert.equal(d1Quotas[1].aggregation_mode, 'unavailable');
        assert.deepEqual(d1Quotas[1].accounting_issues, ['UNREACHABLE']);
        assert.deepEqual(d1Quotas[1].account_ids, ['acc-1']);
    });
});

test('a shard answering 200 with a non-conforming body is treated as unreachable', async () => {
    resetD1QuotaStateForTests({ now: () => now });
    resetShardMapCacheForTests();
    await withFetch(async () => Response.json({ rows_read: 'x' }), async () => {
        const response = await statistics.getD1Quota(context(kvWithMap(shardMap())));
        const { d1Quotas } = await response.json();
        assert.equal(d1Quotas.length, 2);
        assert.equal(d1Quotas[1].reachable, false);
        assert.equal(d1Quotas[1].unavailable_reason, 'invalid_quota_payload');
        // Garbage must not be spread into the card as if it were a measurement.
        assert.equal(d1Quotas[1].rows_read, 0);
        assert.equal(d1Quotas[1].accounts_known, true);
        assert.deepEqual(d1Quotas[1].account_ids, ['acc-1']);
    });
});

test('a malformed registry degrades to the primary card instead of failing', async () => {
    resetD1QuotaStateForTests({ now: () => now });
    resetShardMapCacheForTests();
    const kv = { get: async (key) => (key === SHARD_MAP_KV_KEY ? '{ not json' : null) };
    const response = await statistics.getD1Quota(context(kv));
    assert.equal(response.status, 200);
    const { d1Quotas } = await response.json();
    assert.equal(d1Quotas.length, 1);
    assert.equal(d1Quotas[0].shard_id, 'primary');
    assert.equal(d1Quotas[0].reachable, true);
});

const validQuotaView = () => ({ ...remoteQuota });

test('isD1QuotaView accepts a conforming view and rejects each broken field', () => {
    assert.equal(isD1QuotaView(validQuotaView()), true);
    assert.equal(isD1QuotaView(null), false);
    assert.equal(isD1QuotaView('nope'), false);
    assert.equal(isD1QuotaView([]), false);
    // flushed_at is null until the first flush; that must stay valid.
    assert.equal(isD1QuotaView({ ...validQuotaView(), flushed_at: null }), true);
    const broken = [
        { shard_id: 1 },
        { utc_date: 1 },
        { rows_read: 'x' },
        { rows_written: NaN },
        { rows_read_limit: 'x' },
        { rows_written_limit: 'x' },
        { rows_read_pct: 'x' },
        { rows_written_pct: 'x' },
        { pending_unflushed: null },
        { pending_unflushed: { rows_read: 0 } },
        { flushed_at: 'x' },
        { flush_count: 'x' },
        { aggregation_mode: 1 },
        { confidence: 1 },
        { accounting_issues: 'x' },
    ];
    for (const patch of broken) {
        assert.equal(isD1QuotaView({ ...validQuotaView(), ...patch }), false, JSON.stringify(patch));
    }
});

test('statistics endpoint batches its six counts into one D1 round trip', async () => {
    resetD1QuotaStateForTests({ now: () => now });
    resetShardMapCacheForTests();
    const batches = [];
    const counts = [11, 22, 3, 4, 55, 66];
    const db = {
        prepare: (sql) => ({ sql }),
        batch: async (statements) => {
            batches.push(statements.map((statement) => statement.sql));
            return statements.map((_, index) => ({ results: [{ count: counts[index] }] }));
        },
    };
    const c = {
        env: { KV: { get: async () => null }, DB: db },
        req: { raw: { signal: undefined } },
        json: (value) => Response.json(value),
    };
    const response = await statistics.get(c);
    assert.equal(response.status, 200);
    const body = await response.json();
    // One round trip, six statements, in the order the fields are destructured.
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0], [
        `SELECT count(*) as count FROM raw_mails`,
        `SELECT count(*) as count FROM address`,
        `SELECT count(*) as count FROM address where updated_at > datetime('now', '-7 day')`,
        `SELECT count(*) as count FROM address where updated_at > datetime('now', '-30 day')`,
        `SELECT count(*) as count FROM sendbox`,
        `SELECT count(*) as count FROM users`,
    ]);
    assert.equal(body.mailCount, 11);
    assert.equal(body.addressCount, 22);
    assert.equal(body.activeAddressCount7days, 3);
    assert.equal(body.activeAddressCount30days, 4);
    assert.equal(body.sendMailCount, 55);
    assert.equal(body.userCount, 66);
    assert.equal(body.d1Quotas.length, 1);
    assert.equal(body.d1Quotas[0].shard_id, 'primary');
    assert.equal(body.d1Quota.rows_read, 0);
});
