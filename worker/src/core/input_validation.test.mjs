import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';

// Modules under test use bundler-style extensionless/directory imports; teach
// the ESM resolver the same .ts / /index.ts fallback the other tests use.
registerHooks({ resolve(specifier, context, next) {
    try { return next(specifier, context); }
    catch (cause) {
        if (!specifier.startsWith('.')) throw cause;
        for (const suffix of ['.ts', '/index.ts']) {
            const target = new URL(specifier + suffix, context.parentURL);
            if (existsSync(target)) return next(target.href, context);
        }
        throw cause;
    }
} });
const { handleListQuery, handleMailListQuery, sendWebhook, isValidWebhookHeaders } = await import('../common.ts');
const { default: adminWebhookSettings } = await import('../admin_api/mail_webhook_settings.ts');
const { default: userWebhookSettings } = await import('../mails_api/webhook_settings.ts');

// A context whose DB throws on any use: these cases must reject the request
// before touching D1, so an invalid offset never reaches the LIMIT/OFFSET bind.
const context = (db = { prepare() { throw new Error('DB must not be touched'); } }) => ({
    env: { DB: db },
    get: () => undefined,
    text: (body, status) => new Response(body, { status }),
    json: (value) => Response.json(value),
});

const countingDb = () => {
    const bound = [];
    return {
        bound,
        prepare(sql) {
            return {
                sql,
                bind(...args) { bound.push(args); return this; },
                all: async () => ({ results: [] }),
                first: async () => 0,
            };
        },
    };
};

// parseInt('abc') is NaN, and NaN fails every relational comparison, so the old
// `offset < 0` guard let it through and bound NaN into LIMIT/OFFSET.
for (const bad of ['abc', '', '  ', 'NaN', '-1', 'null']) {
    test(`handleListQuery rejects a non-integer offset (${JSON.stringify(bad)})`, async () => {
        const response = await handleListQuery(context(), 'SELECT * FROM address', 'SELECT count(*) as count FROM address', [], '10', bad);
        assert.equal(response.status, 400);
        assert.equal(await response.text(), 'Invalid offset');
    });

    test(`handleMailListQuery rejects a non-integer offset (${JSON.stringify(bad)})`, async () => {
        const response = await handleMailListQuery(context(), 'SELECT * FROM raw_mails', 'SELECT count(*) as count FROM raw_mails', [], '10', bad);
        assert.equal(response.status, 400);
        assert.equal(await response.text(), 'Invalid offset');
    });
}

test('handleListQuery still accepts a valid offset and binds it as a number', async () => {
    const db = countingDb();
    const response = await handleListQuery(context(db), 'SELECT * FROM address', 'SELECT count(*) as count FROM address', [], '10', '20');
    assert.equal(response.status, 200);
    assert.deepEqual(db.bound.at(-1), [10, 20]);
});

test('handleListQuery treats a numeric-prefixed offset like parseInt did', async () => {
    const db = countingDb();
    const response = await handleListQuery(context(db), 'SELECT * FROM address', 'SELECT count(*) as count FROM address', [], '10', '20abc');
    assert.equal(response.status, 200);
    assert.deepEqual(db.bound.at(-1), [10, 20]);
});

// settings.headers is a free-form persisted string. A non-JSON value must fail
// this one delivery instead of throwing, because triggerWebhook awaits
// sendWebhook in a loop and a throw would silently skip every later webhook.
test('sendWebhook fails cleanly on non-JSON headers without throwing', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('fetch must not be called'); };
    try {
        const result = await sendWebhook(
            { url: 'https://example.com/hook', method: 'POST', headers: 'not json', body: '{}' },
            {},
        );
        assert.equal(result.success, false);
        assert.match(result.message, /invalid webhook headers/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('sendWebhook fails cleanly when headers is a JSON array or null', async () => {
    for (const headers of ['[]', 'null', '"text"', '42']) {
        const result = await sendWebhook(
            { url: 'https://example.com/hook', method: 'POST', headers, body: '{}' },
            {},
        );
        assert.equal(result.success, false, headers);
    }
});

test('sendWebhook sends parsed headers for a valid JSON object', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), headers: init.headers });
        return new Response('', { status: 200 });
    };
    try {
        const result = await sendWebhook(
            { url: 'https://example.com/hook', method: 'POST', headers: '{"X-Test":"1"}', body: '{}' },
            {},
        );
        assert.equal(result.success, true);
        assert.deepEqual(calls[0].headers, { 'X-Test': '1' });
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('sendWebhook treats empty headers as no custom headers', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push(init.headers);
        return new Response('', { status: 200 });
    };
    try {
        const result = await sendWebhook(
            { url: 'https://example.com/hook', method: 'POST', headers: '   ', body: '{}' },
            {},
        );
        assert.equal(result.success, true);
        assert.deepEqual(calls[0], {});
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('isValidWebhookHeaders accepts empty and JSON objects, rejects the rest', () => {
    assert.equal(isValidWebhookHeaders(''), true);
    assert.equal(isValidWebhookHeaders('   '), true);
    assert.equal(isValidWebhookHeaders('{}'), true);
    assert.equal(isValidWebhookHeaders('{"A":"b"}'), true);
    assert.equal(isValidWebhookHeaders('not json'), false);
    assert.equal(isValidWebhookHeaders('[]'), false);
    assert.equal(isValidWebhookHeaders('null'), false);
    assert.equal(isValidWebhookHeaders('"text"'), false);
    assert.equal(isValidWebhookHeaders({ A: 'b' }), false);
});

// A broken headers value must be rejected before it is persisted, so it cannot
// later throw on every delivery.
const saveContext = (settings, jwtPayload) => {
    const puts = [];
    return {
        puts,
        env: { KV: { get: async () => null, put: async (...args) => { puts.push(args); } } },
        req: { json: async () => settings },
        get: (key) => (key === 'jwtPayload' ? jwtPayload : undefined),
        text: (body, status) => new Response(body, { status }),
        json: (value) => Response.json(value),
    };
};

test('admin saveWebhookSettings rejects non-JSON headers before persisting', async () => {
    const c = saveContext({ url: 'https://example.com/hook', headers: 'not json', enabled: true });
    const response = await adminWebhookSettings.saveWebhookSettings(c);
    assert.equal(response.status, 400);
    assert.equal(c.puts.length, 0);
});

test('admin saveWebhookSettings persists valid settings', async () => {
    const c = saveContext({ url: 'https://example.com/hook', headers: '{"A":"b"}', enabled: true });
    const response = await adminWebhookSettings.saveWebhookSettings(c);
    assert.equal(response.status, 200);
    assert.equal(c.puts.length, 1);
});

test('user saveWebhookSettings rejects non-JSON headers before persisting', async () => {
    const c = saveContext({ url: 'https://example.com/hook', headers: '[]', enabled: true }, { address: 'a@example.com' });
    const response = await userWebhookSettings.saveWebhookSettings(c);
    assert.equal(response.status, 400);
    assert.equal(c.puts.length, 0);
});
