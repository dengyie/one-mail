import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';

// The handlers use bundler-style extensionless/directory imports; teach the ESM
// resolver the same .ts / /index.ts fallback the other handler tests use.
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
const { default: addressApi } = await import('./address_api.ts');

// The admin delete path must mirror the user-facing delete paths: it clears the
// unified `emails` rows too, or a later owner of the same address name inherits
// the previous owner's inbox history (emails ownership is `to_addr`).
const makeDb = (first, batchOk = true) => {
    const batchSql = [];
    return {
        batchSql,
        batchCalls: 0,
        prepare(sql) {
            return { sql, bind() { return this; }, first: async () => first };
        },
        async batch(statements) {
            this.batchCalls += 1;
            batchSql.push(...statements.map((statement) => statement.sql));
            return statements.map(() => ({ success: batchOk }));
        },
    };
};

const context = (db) => ({
    env: { DB: db },
    req: { param: () => ({ id: '5' }) },
    get: () => undefined,
    text: (body, status) => new Response(body, { status }),
    json: (value) => Response.json(value),
});

test('admin deleteAddress also removes the unified emails rows', async () => {
    const db = makeDb({ source_meta: 'admin' });
    const response = await addressApi.deleteAddress(context(db));
    assert.equal(response.status, 200);
    const emailsDelete = db.batchSql.filter((sql) => /DELETE FROM emails WHERE to_addr IN/.test(sql));
    assert.equal(emailsDelete.length, 1, JSON.stringify(db.batchSql));
    // The address row is deleted last, so the name subqueries still resolve.
    assert.match(db.batchSql.at(-1), /DELETE FROM address WHERE id = \?/);
    // The unified cleanup runs before the address row it selects from.
    assert.ok(db.batchSql.indexOf(emailsDelete[0]) < db.batchSql.length - 1);
});

test('admin deleteAddress refuses external reference rows and touches nothing', async () => {
    const db = makeDb({ source_meta: 'external' });
    const response = await addressApi.deleteAddress(context(db));
    assert.equal(response.status, 404);
    assert.equal(db.batchCalls, 0);
});

// Admin-specified names must land verbatim: the receive path matches addresses
// by exact name, so a silently stripped name (e.g. dots removed from
// iris.finch28) turns the requested address into a mail blackhole.
const makeCreateDb = () => {
    const inserts = [];
    return {
        inserts,
        prepare(sql) {
            let args = null;
            return {
                sql,
                bind(...bound) { args = bound; return this; },
                run: async () => {
                    if (/INSERT INTO address/.test(sql)) {
                        inserts.push({ name: args[0], sourceMeta: args[1] });
                    }
                    return { success: true, meta: { last_row_id: 1 } };
                },
                first: async () => {
                    if (/SELECT value FROM settings/.test(sql)) return null;
                    if (/SELECT id FROM address/.test(sql)) return 42;
                    return null;
                },
            };
        },
    };
};

const createContext = (db, body) => ({
    env: {
        DB: db,
        JWT_SECRET: 'test-jwt-secret-0123456789',
        DOMAINS: JSON.stringify(['example.com']),
    },
    req: { json: async () => body },
    get: () => undefined,
    text: (body, status) => new Response(body, { status }),
    json: (value) => Response.json(value),
    executionCtx: { waitUntil: (promise) => { promise.catch(() => { }); } },
});

test('admin create keeps dotted and underscored names verbatim', async () => {
    for (const requested of ['e2e.dot.test', 'foo_bar']) {
        const db = makeCreateDb();
        const response = await addressApi.createNewAddress(createContext(db, {
            name: requested, domain: 'example.com', enablePrefix: false,
        }));
        assert.equal(response.status, 200, requested);
        const body = await response.json();
        assert.equal(db.inserts.length, 1, requested);
        assert.equal(db.inserts[0].name, `${requested}@example.com`, requested);
        assert.equal(db.inserts[0].sourceMeta, 'admin', requested);
        // the response address must always equal the stored name
        assert.equal(body.address, db.inserts[0].name, requested);
    }
});

test('admin create rejects names outside the whitelist without inserting', async () => {
    const db = makeCreateDb();
    const response = await addressApi.createNewAddress(createContext(db, {
        name: 'bad name!', domain: 'example.com', enablePrefix: false,
    }));
    assert.equal(response.status, 400);
    assert.match(await response.text(), /Name only allows lowercase letters/);
    assert.equal(db.inserts.length, 0);
});
