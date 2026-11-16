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
const { newAddress } = await import('../common.ts');

// Capture the inserted address name: the acceptance contract is that the
// response `address` always equals the stored `address.name` — a mismatch here
// is the mail blackhole regression (receive path matches by exact name).
const makeDb = () => {
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

const context = (db) => ({
    env: {
        DB: db,
        JWT_SECRET: 'test-jwt-secret-0123456789',
        DOMAINS: JSON.stringify(['example.com']),
    },
    get: () => undefined,
    text: (body, status) => new Response(body, { status }),
    json: (value) => Response.json(value),
    executionCtx: { waitUntil: (promise) => { promise.catch(() => { }); } },
});

// Open registration must keep the strict strip semantics unchanged: characters
// outside [a-z0-9] are removed before insert, and the response address equals
// the stripped (stored) name.
test('open registration path still strips special characters from the name', async () => {
    const db = makeDb();
    const res = await newAddress(context(db), {
        name: 'foo.bar', domain: 'example.com', enablePrefix: false,
    });
    assert.equal(db.inserts.length, 1);
    assert.equal(db.inserts[0].name, 'foobar@example.com');
    assert.equal(res.address, db.inserts[0].name);
});

// Admin-specified names must land verbatim: dotted and underscored names are
// kept as requested, never silently rewritten.
test('preserveName keeps dotted and underscored names verbatim', async () => {
    for (const requested of ['e2e.dot.test', 'foo_bar', 'iris.finch28']) {
        const db = makeDb();
        const res = await newAddress(context(db), {
            name: requested, domain: 'example.com', enablePrefix: false,
            preserveName: true,
        });
        assert.equal(db.inserts.length, 1, requested);
        assert.equal(db.inserts[0].name, `${requested}@example.com`, requested);
        assert.equal(res.address, db.inserts[0].name, requested);
    }
});

// The admin channel contract is "requested name === stored name, otherwise
// explicit failure": anything outside the lenient whitelist must reject
// instead of being stripped into a different address.
test('preserveName rejects names outside the lenient whitelist explicitly', async () => {
    for (const requested of ['bad name', 'Foo.Bar', 'foo+bar', 'foo bar!', '']) {
        const db = makeDb();
        await assert.rejects(
            newAddress(context(db), {
                name: requested, domain: 'example.com', enablePrefix: false,
                preserveName: true,
            }),
            /Name only allows lowercase letters, digits, dot, underscore and hyphen/,
            requested,
        );
        assert.equal(db.inserts.length, 0, requested);
    }
});

// RegExp.test coerces non-strings (e.g. a JSON number body 123 -> "123"),
// which would silently pass validation; the admin channel must reject them.
test('preserveName rejects non-string names without inserting', async () => {
    for (const requested of [123, null, { evil: true }]) {
        const db = makeDb();
        await assert.rejects(
            newAddress(context(db), {
                name: requested, domain: 'example.com', enablePrefix: false,
                preserveName: true,
            }),
            /Name only allows lowercase letters, digits, dot, underscore and hyphen/,
            String(requested),
        );
        assert.equal(db.inserts.length, 0, String(requested));
    }
});

// Leading/trailing/double dots make the local part undeliverable for most
// sending MTAs (they normalize or reject), which recreates the receive
// blackhole from the other side even though the name is stored verbatim.
test('preserveName rejects invalid dot positions in the name', async () => {
    for (const requested of ['.foo', 'foo.', 'foo..bar', '.']) {
        const db = makeDb();
        await assert.rejects(
            newAddress(context(db), {
                name: requested, domain: 'example.com', enablePrefix: false,
                preserveName: true,
            }),
            /Name only allows lowercase letters, digits, dot, underscore and hyphen/,
            requested,
        );
        assert.equal(db.inserts.length, 0, requested);
    }
});

// Interior single dots stay valid dot-atoms and must keep landing verbatim.
test('preserveName keeps interior-dot names verbatim', async () => {
    for (const requested of ['iris.finch28', 'a.b.c']) {
        const db = makeDb();
        const res = await newAddress(context(db), {
            name: requested, domain: 'example.com', enablePrefix: false,
            preserveName: true,
        });
        assert.equal(db.inserts.length, 1, requested);
        assert.equal(db.inserts[0].name, `${requested}@example.com`, requested);
        assert.equal(res.address, db.inserts[0].name, requested);
    }
});
