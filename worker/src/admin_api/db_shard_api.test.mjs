import assert from 'node:assert/strict';
import test from 'node:test';
import db_shard_api from './db_shard_api.ts';
import { resetShardMapCacheForTests, SHARD_MAP_KV_KEY } from '../unified/shard_map.ts';

const SHARD_TOKEN = 's'.repeat(32);
const shardMap = (overrides = {}) => JSON.stringify({
    v: 1,
    shards: [{ id: 'shard-b', name: 'one_mail_shard1', base_url: 'https://shard-b.example.com', token: SHARD_TOKEN }],
    accounts: { 'acc-1': 'shard-b' },
    ...overrides,
});
const kvWithMap = (map) => ({ get: async (key) => (key === SHARD_MAP_KV_KEY ? map : null) });
const context = (kv, body) => ({
    env: { KV: kv },
    req: { raw: { signal: undefined }, json: async () => body },
    json: (value, status) => Response.json(value, { status }),
});
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
});
const withFetch = async (impl, run) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = impl;
    try { return await run(); } finally { globalThis.fetch = originalFetch; }
};

test.beforeEach(() => {
    resetShardMapCacheForTests();
});

test('list keeps a legacy-static deployment explicit: no shards, no registry error', async () => {
    let fetched = 0;
    const response = await withFetch(() => { fetched += 1; return jsonResponse({}); }, async () =>
        db_shard_api.list(context(kvWithMap(null))));
    assert.equal(response.status, 200);
    const { primary, shards, registry_error } = await response.json();
    assert.equal(primary.shard_id, 'primary');
    assert.equal(primary.database_name, 'primary');
    assert.equal(primary.is_shard_mode, false);
    assert.deepEqual(shards, []);
    assert.equal(registry_error, null);
    assert.equal(fetched, 0);
});

test('list surfaces a malformed registry instead of hiding it behind an empty list', async () => {
    const response = await db_shard_api.list(context(kvWithMap('not json')));
    assert.equal(response.status, 200);
    const { shards, registry_error } = await response.json();
    assert.deepEqual(shards, []);
    assert.equal(registry_error, 'invalid_shard_map');
});

test('list probes registered shards and never leaks the registry token', async () => {
    const calls = [];
    const response = await withFetch(async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ ok: true, shard_id: 'shard-b', shard_mode: true });
    }, async () => db_shard_api.list(context(kvWithMap(shardMap()))));
    assert.equal(response.status, 200);
    const { shards } = await response.json();
    assert.equal(shards.length, 1);
    assert.deepEqual(shards[0], {
        id: 'shard-b',
        name: 'one_mail_shard1',
        base_url: 'https://shard-b.example.com',
        account_ids: ['acc-1'],
        reachable: true,
        unavailable_reason: null,
        reported_shard_id: 'shard-b',
        shard_mode: true,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://shard-b.example.com/shard/health');
    assert.equal(calls[0].init.headers.authorization, `Bearer ${SHARD_TOKEN}`);
    assert.ok(!JSON.stringify(shards).includes(SHARD_TOKEN));
});

test('list degrades a non-conforming health payload instead of trusting it', async () => {
    const response = await withFetch(async () => jsonResponse({ ok: true, shard_id: 'shard-b' }), async () =>
        db_shard_api.list(context(kvWithMap(shardMap()))));
    const { shards } = await response.json();
    assert.equal(shards[0].reachable, false);
    assert.equal(shards[0].unavailable_reason, 'invalid_health_payload');
    assert.equal(shards[0].reported_shard_id, null);
});

test('list reports a transport failure with its reason', async () => {
    const response = await withFetch(async () => { throw new Error('boom'); }, async () =>
        db_shard_api.list(context(kvWithMap(shardMap()))));
    const { shards } = await response.json();
    assert.equal(shards[0].reachable, false);
    assert.equal(shards[0].unavailable_reason, 'network');
});

test('initialize forwards to the registered endpoint with the registry token', async () => {
    const calls = [];
    const response = await withFetch(async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ ok: true });
    }, async () => db_shard_api.initialize(context(kvWithMap(shardMap()), { shard_id: 'shard-b' })));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        ok: true,
        shard_id: 'shard-b',
        message: 'Shard schema initialized',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://shard-b.example.com/shard/schema/initialize');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.body, '{}');
    assert.equal(calls[0].init.headers.authorization, `Bearer ${SHARD_TOKEN}`);
    assert.equal(calls[0].init.headers['content-type'], 'application/json');
});

test('initialize never fetches a URL outside the registry', async () => {
    const urls = [];
    await withFetch(async (url) => {
        urls.push(String(url));
        return jsonResponse({ ok: true });
    }, async () => db_shard_api.initialize(context(kvWithMap(shardMap()), { shard_id: 'shard-b' })));
    assert.deepEqual(urls, ['https://shard-b.example.com/shard/schema/initialize']);
});

test('initialize rejects a missing, empty or non-object body', async () => {
    for (const body of [undefined, 'shard-b', {}, { shard_id: '  ' }, { shard_id: 7 }]) {
        const response = await db_shard_api.initialize(context(kvWithMap(shardMap()), body));
        assert.equal(response.status, 400, `body ${JSON.stringify(body)}`);
        const { ok, error } = await response.json();
        assert.equal(ok, false);
        assert.equal(error, 'shard_id is required');
    }
});

test('initialize refuses to proxy the primary database', async () => {
    let fetched = 0;
    const response = await withFetch(() => { fetched += 1; return jsonResponse({ ok: true }); }, async () =>
        db_shard_api.initialize(context(kvWithMap(shardMap()), { shard_id: 'primary' })));
    assert.equal(response.status, 400);
    assert.equal(fetched, 0);
});

test('initialize rejects an unregistered shard id without any network call', async () => {
    let fetched = 0;
    const response = await withFetch(() => { fetched += 1; return jsonResponse({ ok: true }); }, async () =>
        db_shard_api.initialize(context(kvWithMap(shardMap()), { shard_id: 'shard-c' })));
    assert.equal(response.status, 404);
    const { ok, error } = await response.json();
    assert.equal(ok, false);
    assert.equal(error, 'unknown shard id');
    assert.equal(fetched, 0);
});

test('initialize maps a shard-side HTTP failure to a 502 with the reason', async () => {
    const response = await withFetch(async () => jsonResponse({ error: 'boom' }, 500), async () =>
        db_shard_api.initialize(context(kvWithMap(shardMap()), { shard_id: 'shard-b' })));
    assert.equal(response.status, 502);
    const { ok, shard_id, error } = await response.json();
    assert.equal(ok, false);
    assert.equal(shard_id, 'shard-b');
    assert.equal(error, 'http_500');
});

test('initialize reports a non-conforming success payload instead of a false positive', async () => {
    const response = await withFetch(async () => jsonResponse({ unexpected: true }), async () =>
        db_shard_api.initialize(context(kvWithMap(shardMap()), { shard_id: 'shard-b' })));
    assert.equal(response.status, 502);
    const { error } = await response.json();
    assert.equal(error, 'invalid_initialize_payload');
});

test('initialize fails closed when the registry itself is unreadable', async () => {
    let fetched = 0;
    const response = await withFetch(() => { fetched += 1; return jsonResponse({ ok: true }); }, async () =>
        db_shard_api.initialize(context(kvWithMap('not json'), { shard_id: 'shard-b' })));
    assert.equal(response.status, 503);
    const { ok, error } = await response.json();
    assert.equal(ok, false);
    assert.equal(error, 'shard registry unavailable');
    assert.equal(fetched, 0);
});
