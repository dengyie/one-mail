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
