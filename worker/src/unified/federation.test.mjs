import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";
import { DatabaseSync } from "node:sqlite";
import { Buffer } from "node:buffer";
import { setImmediate } from "node:timers";
import { encodeEmailCursor } from "./cursor.ts";

// Exercise real routes without external auth/settings/providers. Extensionless
// imports are resolved like the Worker bundler; only unrelated boundaries stub.
const commonUrl = new URL("../common.ts", import.meta.url).href;
const utilsUrl = new URL("../utils.ts", import.meta.url).href;
const accountsUrl = new URL("../user_api/mail_accounts.ts", import.meta.url).href;
const commonSource = readFileSync(new URL(commonUrl), "utf8");
const listSource = commonSource.slice(commonSource.indexOf("export const handleListQuery = async"), commonSource.indexOf("export const hideObjectFields"));
const hooks = registerHooks({
    resolve(specifier, context, next) {
        try { return next(specifier, context); } catch (error) {
            if (!specifier.startsWith(".")) throw error;
            for (const suffix of [".ts", "/index.ts"]) {
                const url = new URL(specifier + suffix, context.parentURL);
                if (existsSync(url)) return next(url.href, context);
            }
            throw error;
        }
    },
    load(url, context, next) {
        let source;
        if (url === commonUrl) source = `const i18n = { getMessagesbyContext: () => ({InvalidLimitMsg:'invalid limit',InvalidOffsetMsg:'invalid offset'}) }; const hideObjectFields=x=>x; export const commonGetUserRole=async()=>null; ${listSource}`;
        if (url === utilsUrl) source = "export const checkIsAdmin=async()=>false;";
        if (url === accountsUrl) source = "export default {};";
        if (source === undefined) return next(url, context);
        return { format: "module", source: ts.transpile(source, { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext }), shortCircuit: true };
    },
});
const { Hono } = await import("hono");
const federation = await import("./federation.ts");
const { default: unified } = await import("./index.ts");
const { resetShardMapCacheForTests } = await import("./shard_map.ts");
const { executeCursorList, executeUnboundedOffsetList } = await import("./unified_list.ts");
const { boundedEmailFilter } = await import("./unified_sql.ts");
const { buildEmailFilters } = await import("./unified_query.ts");
const { default: shardRoutes } = await import("./shard_routes.ts");
const { initializeShardSchema } = await import("./shard_schema.ts");
const { hashKey } = await import("./api_keys.ts");
hooks.deregister();

const map = { v: 1, shards: [{ id: "s1", base_url: "https://shard.invalid", token: "t".repeat(32) }], accounts: { mine: "s1", other: "s1" } };
const user = { userPayload: { user_id: 1, exp: 9999999999 }, isAdmin: false, userRole: null };
const readonly = { role: "readonly", allowed_accounts: '["mine"]', allowed_sources: '["imap_gmail"]' };
function db({ trace = [], rows = [], email = null, owned = ["mine"] } = {}) {
    return {
        prepare(sql) {
            let params = [];
            return {
                bind(...values) { params = values; trace.push({ sql, params }); return this; },
                async all() { return { results: sql.includes("SELECT id FROM user_mail_accounts") ? owned.map(id => ({ id })) : rows }; },
                async first(column) {
                    if (sql.includes("FROM emails WHERE id")) {
                        const excluded = sql.includes("json_each") && email?.source !== "cf_routing" && JSON.parse(params.at(-1)).includes(email?.account_id);
                        return excluded ? null : email;
                    }
                    if (sql.includes("SELECT CASE WHEN")) return email?.account_id === "mine" ? 1 : 0;
                    if (sql.includes("FROM mail_mutation_jobs WHERE id")) return null;
                    return column ? 0 : { count: 0, unread: 0 };
                },
                async run() { return { success: true }; },
            };
        },
        async batch() { return []; },
    };
}
function context(key = null, options = {}, query = {}) {
    return { env: { DB: db(options) }, get: name => name === "apiKey" ? key : name === "unifiedUserAuth" ? (key ? undefined : user) : undefined,
        req: { query: name => name === undefined ? query : query[name] }, json: (body, status = 200) => Response.json(body, { status }) };
}
function gateway(database, registry = map) {
    resetShardMapCacheForTests();
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("userPayload", user.userPayload); await next(); });
    app.route("/", unified);
    return { app, env: { DB: database, KV: { get: async () => JSON.stringify(registry) } } };
}
async function withFetch(impl, run) {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try { return await run(); } finally { globalThis.fetch = original; }
}
const headers = { "x-user-token": "verified-at-test-boundary" };

const applyRoute = (path, init) => {
    const { app, env } = gateway(db());
    return app.request(`https://gateway.invalid${path.replace("/shard/", "/api/unified/")}`, { ...init, headers }, env);
};

test("remote single-row reads, mutations and status carry fail-closed ownership scope", async () => {
    const seen = [];
    await withFetch(async (_url, init) => {
        const scope = JSON.parse(decodeURIComponent(init.headers["x-one-mail-shard-scope"]));
        seen.push(scope);
        // A shard enforcing this scope rejects another tenant before applying.
        return Response.json({ error: "forbidden" }, { status: 403 });
    }, async () => {
        for (const [path, init] of [["/shard/emails/other", {}], ["/shard/emails/other/read", { method: "POST" }], ["/shard/mutations/other", {}]]) {
            const response = init.method ? await applyRoute(path, init) : await federation.fanOutGet(context(), map, path);
            assert.equal(response.status, 403);
        }
    });
    assert.equal(seen.length, 3);
    for (const scope of seen) assert.deepEqual(scope, { account_ids: ["mine"], sources: null });
});

test("readonly source and account scope reaches list and every extra endpoint", async () => {
    const calls = [];
    await withFetch(async (url, init) => {
        calls.push({ url, init });
        return Response.json({ results: [], count: 0, unread: 0, sources: [], accounts: [], to_addrs: [] });
    }, async () => {
        await federation.federatedListEmails(context(readonly), map, { rest: {}, limit: 1, withCount: false });
        for (const endpoint of [federation.federatedCount, federation.federatedStats, federation.federatedVerifCodes, federation.federatedMeta, federation.federatedFolders]) await endpoint(context(readonly), map);
    });
    const list = JSON.parse(calls[0].init.body);
    assert.equal(list.source, "imap_gmail");
    assert.deepEqual(list.account_ids, ["mine"]);
    for (const call of calls.slice(1)) {
        const query = new URL(call.url).searchParams;
        assert.equal(query.get("source"), "imap_gmail");
        assert.deepEqual(JSON.parse(decodeURIComponent(call.init.headers["x-one-mail-shard-scope"])), { account_ids: ["mine"], sources: ["imap_gmail"] });
    }
});

test("unrestricted readonly accounts read every active owner but not orphan shard copies", async () => {
    let accountIds;
    await withFetch(async (_url, init) => {
        accountIds = JSON.parse(init.body).account_ids;
        return Response.json({ results: [], count: 0 });
    }, () => federation.federatedListEmails(context({ ...readonly, allowed_accounts: null }), map, { rest: {}, limit: 1, withCount: false }));
    assert.deepEqual(accountIds, ["mine", "other"]);
});

test("negative limit and invalid/deep offsets reject before DB/fetch", async () => {
    const trace = [];
    await withFetch(() => { throw Error("must not fetch"); }, async () => {
        for (const input of [{ limit: -3 }, { limit: 1, offset: -1 }, { limit: 1, offset: 1.5 }, { limit: 1, offset: NaN }, { limit: 1, offset: 501 }]) {
            const response = await federation.federatedListEmails(context(null, { trace }), map, { rest: {}, withCount: false, ...input });
            assert.equal(response.status, 400);
        }
        const { app, env } = gateway(db({ trace }));
        for (const query of ["limit=-3", "limit=1&offset=NaN", "limit=1&offset=-1"]) assert.equal((await app.request("https://gateway.invalid/api/unified/emails?" + query, { headers }, env)).status, 400);
    });
    assert.equal(trace.length, 0);
    for (const execute of [executeCursorList, executeUnboundedOffsetList]) await assert.rejects(() => execute(context(), { where: "1=1", params: [], limit: -1, withCount: false }), /invalid limit/);
});

test("global remote exclusion uses one binding even for thousands of accounts", () => {
    const large = { ...map, accounts: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => ["a" + i, "s1"])) };
    const excluded = federation.excludeRemoteSql(large);
    assert.match(excluded.sql, /json_each\(\?\)/);
    assert.equal(excluded.params.length, 1);
    assert.equal(JSON.parse(excluded.params[0]).length, 1000);
});

test("remote unsupported response survives; network and 5xx are not false misses", async () => {
    for (const status of [400, 403, 409]) await withFetch(async () => Response.json({ error: "provider mutation unsupported", status: "unsupported" }, { status }), async () => {
        const response = await applyRoute("/shard/emails/id", { method: "DELETE" });
        assert.equal(response.status, status);
        assert.equal((await response.json()).status, "unsupported");
    });
    for (const impl of [async () => { throw Error("network"); }, async () => new Response("down", { status: 503 })]) await withFetch(impl, async () => {
        const response = await federation.fanOutGet(context(), map, "/shard/emails/id");
        assert.equal(response.status, 503);
        assert.deepEqual((await response.json()).degraded, ["s1"]);
    });
});

test("degraded pagination exposes incomplete results without count or cursor advancement", async () => {
    const registry = { ...map, accounts: { mine2: "s2" }, shards: [...map.shards, { ...map.shards[0], id: "s2", base_url: "https://failed.invalid" }] };
    await withFetch(async url => new URL(url).host === "failed.invalid" ? new Response("down", { status: 503 }) : Response.json({ results: [{ id: "a", received_at: 100 }], count: 1 }), async () => {
        const body = await (await federation.federatedListEmails(context(null, { rows: [{ id: "a", received_at: 100 }], owned: ["mine2"] }), registry, { rest: {}, limit: 1, withCount: true })).json();
        assert.equal(body.count, null);
        assert.equal(body.next_cursor, null);
        assert.equal(body.incomplete, true);
        assert.deepEqual(body.unavailable_mailbox_ids, ["mine2"]);
        assert.equal(body.has_more, true);
        assert.deepEqual(body.degraded, ["s2"]);
    });
});

test("one shard failure returns local+healthy results with degraded and ordered cursor", async () => {
    const registry = { ...map, accounts: { ...map.accounts, mine2: "s2" }, shards: [...map.shards, { ...map.shards[0], id: "s2", base_url: "https://failed.invalid" }] };
    await withFetch(async url => new URL(url).host === "failed.invalid" ? new Response("down", { status: 503 }) : Response.json({ results: [{ id: "b", received_at: 100 }], count: 1 }), async () => {
        const response = await federation.federatedListEmails(context(null, { rows: [{ id: "a", received_at: 100 }], owned: ["mine", "mine2"] }), registry, { rest: {}, limit: 1, withCount: false });
        const body = await response.json();
        assert.deepEqual(body.results.map(row => row.id), ["b"]);
        assert.equal(body.has_more, true);
        assert.equal(body.next_cursor, null);
        assert.equal(body.count, null);
        assert.deepEqual(body.degraded, ["s2"]);
    });
});

test("single-row deadline covers a response body stalled after headers", async () => {
    await withFetch(async () => new Response(new ReadableStream({ start() {} })), async () => {
        const started = Date.now();
        const response = await federation.fanOutGet(context(), map, "/shard/emails/id");
        assert.equal(response.status, 503);
        assert(Date.now() - started < 4500);
    });
});

test("mapped migration copies never return stale primary data or queue primary jobs", async () => {
    const trace = [];
    const email = { id: "copy", account_id: "mine", source: "imap_custom", provider: "graph", provider_message_id: "immutable", text_body: "stale primary" };
    const { app, env } = gateway(db({ trace, email }));
    await withFetch(async (_url, init) => Response.json(init.method === "DELETE" ? { ok: true, status: "queued", job_id: "remote-job" } : { ...email, text_body: "fresh shard" }, { status: init.method === "DELETE" ? 202 : 200 }), async () => {
        const detail = await app.request("https://gateway.invalid/api/unified/emails/copy", { headers }, env);
        assert.equal((await detail.json()).text_body, "fresh shard");
        const deleted = await app.request("https://gateway.invalid/api/unified/emails/copy", { headers, method: "DELETE" }, env);
        assert.equal(deleted.status, 202);
        assert.equal((await deleted.json()).job_id, "remote-job");
    });
    assert(!trace.some(({ sql }) => /INSERT INTO mail_mutation_jobs/.test(sql)));
});

test("empty map preserves legacy count bodies and never calls a shard", async () => {
    const { app, env } = gateway(db(), { v: 1, shards: [], accounts: {} });
    await withFetch(() => { throw Error("empty map must stay local"); }, async () => {
        const offset = await app.request("https://gateway.invalid/api/unified/emails?limit=1&offset=0&with_count=0", { headers }, env);
        assert.equal(await offset.text(), '{"results":[],"count":null}');
        const cursor = await app.request("https://gateway.invalid/api/unified/emails?limit=1&with_count=0", { headers }, env);
        assert.equal(await cursor.text(), '{"results":[],"count":null,"next_cursor":null,"has_more":false}');
        // 显式 opt-in 才计数，并且数出来是 0（而不是因为没算才返回 null）。
        const counted = await app.request("https://gateway.invalid/api/unified/emails?limit=1&with_count=1", { headers }, env);
        assert.equal(await counted.text(), '{"results":[],"count":0,"next_cursor":null,"has_more":false}');
        // 不带参数等同于不带 COUNT：整表 COUNT 是 10-08 打爆 D1 免费档的主因。
        const defaulted = await app.request("https://gateway.invalid/api/unified/emails?limit=1", { headers }, env);
        assert.equal(await defaulted.text(), '{"results":[],"count":null,"next_cursor":null,"has_more":false}');
        const missing = await app.request("https://gateway.invalid/api/unified/emails/missing", { headers }, env);
        assert.equal(missing.status, 404);
        assert.equal(await missing.text(), '{"error":"not found"}');
        assert.equal((await app.request("https://gateway.invalid/api/unified/emails/missing", { headers, method: "DELETE" }, env)).status, 404);
    });
});

test("bounded filters preserve SQL results and parameter order around multiple IN lists", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
        sqlite.exec("CREATE TABLE emails(source TEXT,account_id TEXT,to_addr TEXT,subject TEXT,from_addr TEXT,text_body TEXT,received_at INTEGER)");
        sqlite.prepare("INSERT INTO emails VALUES (?,?,?,?,?,?,?)").run("imap_gmail", "mine", "me@test", "code", "sender", "body", 5);
        const filter = buildEmailFilters({ source: "imap_gmail,imap_qq", account_id: "mine,other", to_addr: "me@test,you@test", since: "1", until: "10", q: "code" });
        const bounded = boundedEmailFilter(filter);
        assert.equal(bounded.params.length, 8);
        assert.deepEqual(sqlite.prepare(`SELECT * FROM emails WHERE ${bounded.where}`).all(...bounded.params), sqlite.prepare(`SELECT * FROM emails WHERE ${filter.where}`).all(...filter.params));
    } finally { sqlite.close(); }
});

function sqliteD1() {
    const sqlite = new DatabaseSync(":memory:");
    const trace = [];
    const database = {
        async exec(sql) { sqlite.exec(sql); },
        prepare(sql) {
            let args = [];
            const record = () => trace.push({ sql, params: args });
            return {
                bind(...values) { args = values; assert(values.length <= 100); return this; },
                async all() { record(); return { results: sqlite.prepare(sql).all(...args) }; },
                async first(column) { record(); const row = sqlite.prepare(sql).get(...args) ?? null; return column ? row?.[column] ?? null : row; },
                async run() { record(); return { success: true, meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; },
            };
        },
        async batch(statements) {
            sqlite.exec("BEGIN");
            try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec("COMMIT"); return results; }
            catch (error) { sqlite.exec("ROLLBACK"); throw error; }
        },
    };
    return { sqlite, database, trace };
}

test("gateway and real SQLite shard isolate detail/delete/status/meta for two tenants", async () => {
    const { sqlite, database } = sqliteD1();
    try {
        await initializeShardSchema(database);
        sqlite.exec(`INSERT INTO emails(id,source,account_id,from_addr,to_addr,received_at,provider,provider_message_id)
            VALUES ('owned','imap_gmail','mine','sender','mine@test',1,'graph','p1'),('victim','imap_qq','other','sender','victim@test',2,'graph','p2')`);
        const { app, env } = gateway(db());
        await withFetch((url, init) => shardRoutes.fetch(new Request(url, init), { DB: database, SHARD_TOKEN: map.shards[0].token }), async () => {
            assert.equal((await app.request("https://gateway.invalid/api/unified/emails/victim", { headers }, env)).status, 403);
            assert.equal((await app.request("https://gateway.invalid/api/unified/emails/victim", { headers, method: "DELETE" }, env)).status, 403);
            assert.equal(sqlite.prepare("SELECT count(*) n FROM mail_mutation_jobs").get().n, 0);
            const owned = await app.request("https://gateway.invalid/api/unified/emails/owned", { headers, method: "DELETE" }, env);
            assert.equal(owned.status, 202);
            const { job_id } = await owned.json();
            assert.equal((await app.request(`https://gateway.invalid/api/unified/mutations/${job_id}`, { headers }, env)).status, 200);
            const meta = await (await app.request("https://gateway.invalid/api/unified/meta", { headers }, env)).json();
            assert.deepEqual(meta.accounts, ["mine"]);
            assert.deepEqual(meta.to_addrs, ["mine@test"]);
            const list = await (await federation.federatedListEmails(context(readonly), map, { rest: {}, limit: 10, withCount: false })).json();
            assert.deepEqual(list.results.map(row => row.id), ["owned"]);
        });
    } finally { sqlite.close(); }
});

test("large tenant scope stays below D1 binding ceiling at final list/count/verifcode boundaries", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => "a" + i);
    const registry = { ...map, accounts: Object.fromEntries(ids.map(id => [id, "s1"])) };
    const trace = [];
    const boundDb = db({ trace });
    const c = context({ ...readonly, allowed_accounts: JSON.stringify(ids) }, { trace });
    await withFetch((url, init) => shardRoutes.fetch(new Request(url, init), { DB: boundDb, SHARD_TOKEN: map.shards[0].token }), async () => {
        await federation.federatedListEmails(c, registry, { rest: {}, limit: 1, withCount: false });
        await federation.federatedCount(c, registry);
        await federation.federatedStats(c, registry);
        await federation.federatedVerifCodes(c, registry);
    });
    assert(trace.length > 0);
    assert(trace.every(({ params }) => params.length <= 100));
});

async function topology() {
    const main = sqliteD1();
    const remote = sqliteD1();
    try {
        await initializeShardSchema(main.database);
        await initializeShardSchema(remote.database);
        main.sqlite.exec(`
            CREATE TABLE user_mail_accounts(id TEXT PRIMARY KEY, user_id INTEGER);
            INSERT INTO user_mail_accounts VALUES ('mine',1),('local-account',1),('other',2);
            CREATE TABLE address(id INTEGER PRIMARY KEY, name TEXT, source_meta TEXT);
            CREATE TABLE users_address(user_id INTEGER, address_id INTEGER);
            INSERT INTO address VALUES (1,'mine@test',NULL),(2,'external@test','external');
            INSERT INTO users_address VALUES (1,1),(1,2);
            CREATE TABLE api_keys(id TEXT PRIMARY KEY,name TEXT,key_hash TEXT,role TEXT,
                allowed_sources TEXT,allowed_accounts TEXT,enabled INTEGER,last_used_at INTEGER);
        `);
        const keyToken = "test-readonly-key";
        main.sqlite.prepare("INSERT INTO api_keys VALUES (?,?,?,?,?,?,1,NULL)").run(
            "read-key", "test", await hashKey(keyToken), "readonly", '["imap_gmail"]', '["mine"]');
        const now = Date.now();
        const insertEmail = (store, id, account, source, code, time, provider = "graph") => store.sqlite.prepare(`
            INSERT INTO emails(id,source,account_id,from_addr,to_addr,subject,text_body,received_at,
                internal_date,provider,provider_message_id,source_folder,source_folder_id)
            VALUES (?,?,?,'sender','mine@test','Verification code',?,?,NULL,?,?, 'INBOX','inbox-id')
        `).run(id, source, account, `Verification code: ${code}`, time, provider, "provider-" + id);
        // Deliberately divergent migration copies: even with a newer timestamp,
        // primary copies must never contribute data, codes, or mutation intents.
        insertEmail(main, "migrated", "mine", "imap_gmail", "999999", now + 1000);
        insertEmail(main, "primary-only-copy", "mine", "imap_gmail", "888888", now + 2000);
        insertEmail(remote, "migrated", "mine", "imap_gmail", "222222", now);
        insertEmail(remote, "remote-older", "mine", "imap_gmail", "333333", now - 2000);
        insertEmail(remote, "victim", "other", "imap_qq", "777777", now + 3000);
        insertEmail(remote, "source-denied", "mine", "imap_qq", "666666", now - 3000);
        insertEmail(main, "local", "local-account", "imap_gmail", "444444", now - 1000);
        // cf_routing stays primary even if account_id happens to be mapped.
        insertEmail(main, "native", "mine", "cf_routing", "111111", now, "native");
        insertEmail(main, "victim-local", "unowned", "imap_gmail", "555555", now + 4000);
        insertEmail(main, "null-account", null, "imap_gmail", "121212", now + 5000);
        for (const store of [main, remote]) {
            store.sqlite.exec(`INSERT INTO mail_account_folders
                (id,mail_account_id,provider,provider_folder_id,canonical_name,folder_type,created_at,updated_at)
                VALUES (10,'mine','graph','archive-id','Archive','archive',1,1),
                       (20,'other','graph','victim-archive','Archive','archive',1,1),
                       (30,'local-account','graph','local-archive','Archive','archive',1,1)`);
            store.trace.length = 0;
        }
        const { app, env } = gateway(main.database);
        const calls = [];
        const fetchRemote = (url, init) => {
            calls.push({ url: new URL(url), method: init.method ?? "GET", body: init.body });
            return shardRoutes.fetch(new Request(url, init), { DB: remote.database, SHARD_TOKEN: map.shards[0].token });
        };
        const request = (path, init = {}) => app.request("https://gateway.invalid/api/unified/" + path,
            { ...init, headers: init.headers ?? headers }, env);
        return { main, remote, app, env, calls, fetchRemote, request, keyHeaders: { authorization: `Bearer ${keyToken}` },
            close() { main.sqlite.close(); remote.sqlite.close(); } };
    } catch (error) { main.sqlite.close(); remote.sqlite.close(); throw error; }
}

const mutationCases = [
    ["read", "POST", undefined, "set_read", 1],
    ["unread", "POST", undefined, "set_read", 0],
    ["star", "POST", { is_starred: 1 }, "set_starred", 1],
    ["move", "POST", { folder_id: 10 }, "move", null],
    ["", "DELETE", undefined, "delete", null],
];
const mutationRequest = (id, action, method, body) => [
    `emails/${id}${action ? "/" + action : ""}`,
    { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { ...headers, "content-type": "application/json" } }) },
];

test("main+shard SQLite topology merges lists/cursors/counts/codes and excludes primary copies", async () => {
    const t = await topology();
    try {
        await withFetch(t.fetchRemote, async () => {
            const first = await (await t.request("emails?limit=2&with_count=1")).json();
            assert.deepEqual(first.results.map(row => row.id), ["native", "migrated"]);
            assert.equal(first.count, 5);
            assert.equal(first.has_more, true);
            // 省略 with_count 就是不要总数：整表 COUNT 是 10-08 打爆 D1 免费档的主因。
            const uncounted = await (await t.request("emails?limit=2")).json();
            assert.equal(uncounted.count, null);
            const second = await (await t.request(`emails?limit=10&cursor=${encodeURIComponent(first.next_cursor)}`)).json();
            assert.deepEqual(second.results.map(row => row.id), ["local", "remote-older", "source-denied"]);
            assert.equal(second.count, null);
            assert.equal(second.has_more, false);
            const offset = await (await t.request("emails?limit=2&offset=1&with_count=1")).json();
            assert.deepEqual(offset.results.map(row => row.id), ["migrated", "local"]);
            assert.equal(offset.count, 0);
            assert.deepEqual(await (await t.request("count")).json(), { count: 5 });
            assert.deepEqual(await (await t.request("stats")).json(), { count: 5, unread: 5 });
            const codes = await (await t.request("verifcodes?addr=mine%40test&fresh=10")).json();
            assert.deepEqual(codes.results.map(row => row.code).sort(), ["111111", "222222", "333333", "444444", "666666"]);
            assert.deepEqual(await (await t.request("verifcodes?addr=missing%40test&fresh=10")).json(), { results: [] });
            const detail = await (await t.request("emails/migrated")).json();
            assert.equal(detail.text_body, "Verification code: 222222");
            assert.equal((await t.request("emails/primary-only-copy")).status, 404);
            assert.equal((await t.request("emails/missing")).status, 404);
            const before = t.calls.length;
            assert.equal((await t.request("emails/native")).status, 200);
            assert.equal(t.calls.length, before);
            assert.equal((await t.request("verifcodes?fresh=NaN")).status, 400);
        });
    } finally { t.close(); }
});

for (const [action, method, body, operation, desired] of mutationCases) {
    test(`main+shard SQLite ${action || "delete"} locates then queues only on the owning shard`, async () => {
        const t = await topology();
        try {
            await withFetch(t.fetchRemote, async () => {
                const response = await t.request(...mutationRequest("migrated", action, method, body));
                assert.equal(response.status, 202);
                const result = await response.json();
                assert.equal(result.operation, operation);
                assert.equal(result.desired_value, desired);
                assert.equal(t.main.sqlite.prepare("SELECT count(*) n FROM mail_mutation_jobs").get().n, 0);
                const job = t.remote.sqlite.prepare("SELECT * FROM mail_mutation_jobs WHERE id=?").get(result.job_id);
                assert.equal(job.email_id, "migrated");
                assert.equal(job.account_id, "mine");
                assert.equal(job.operation, operation);
                assert.equal(job.desired_value, desired);
                if (operation === "move") {
                    assert.equal(job.target_folder, "Archive");
                    assert.equal(job.target_folder_id, "archive-id");
                }
                assert.equal(t.calls.length, 2);
                assert.equal(t.calls[0].method, "GET");
                assert.equal(t.calls[0].url.pathname, "/shard/emails/migrated");
                assert.equal(t.calls[1].method, method);
                assert.equal(t.calls[1].url.pathname, `/shard/emails/migrated${action ? "/" + action : ""}`);
                const lookups = t.main.trace.filter(({ sql }) => /FROM emails WHERE id = \?/i.test(sql));
                assert.equal(lookups.length, 1);
                assert.match(lookups[0].sql, /json_each\(\?\)/);
                assert.strictEqual(t.env.DB, t.main.database);
                // Queueing keeps external visible state unchanged until provider completion.
                for (const store of [t.main, t.remote]) {
                    const row = store.sqlite.prepare("SELECT is_read,is_starred,source_folder FROM emails WHERE id='migrated'").get();
                    assert.equal(row.is_read, 0);
                    assert.equal(row.is_starred, 0);
                    assert.equal(row.source_folder, "INBOX");
                }
                assert.equal((await t.request(`mutations/${result.job_id}`)).status, 200);
            });
        } finally { t.close(); }
    });
}

test("main+shard SQLite authorization rejects tenants, sources, readonly writes, and wrong-account moves", async () => {
    const t = await topology();
    try {
        await withFetch(t.fetchRemote, async () => {
            for (const id of ["victim", "victim-local", "null-account"]) {
                assert.equal((await t.request(`emails/${id}`)).status, 403);
                for (const [action, method, body] of mutationCases) {
                    assert.equal((await t.request(...mutationRequest(id, action, method, body))).status, 403);
                }
            }
            assert.equal((await t.request(...mutationRequest("migrated", "move", "POST", { folder_id: 20 }))).status, 400);
            assert.equal((await t.request(...mutationRequest("migrated", "move", "POST", { folder_id: "bad" }))).status, 400);
            const keyRequest = (path, init = {}) => t.request(path, { ...init, headers: t.keyHeaders });
            const list = await (await keyRequest("emails?limit=10&with_count=1")).json();
            assert.deepEqual(list.results.map(row => row.id), ["migrated", "remote-older"]);
            assert.equal(list.count, 2);
            assert.equal((await keyRequest("emails/migrated")).status, 200);
            for (const id of ["source-denied", "victim", "native", "local", "null-account"]) {
                assert.equal((await keyRequest(`emails/${id}`)).status, 403);
            }
            assert.equal((await keyRequest("emails?limit=10&account_id=other")).status, 403);
            assert.equal((await keyRequest("emails?limit=10&source=imap_qq")).status, 403);
            const codes = await (await keyRequest("verifcodes?fresh=10")).json();
            assert.deepEqual(codes.results.map(row => row.code), ["222222", "333333"]);
            for (const [action, method, body] of mutationCases) {
                const [path, init] = mutationRequest("migrated", action, method, body);
                const before = t.calls.length;
                assert.equal((await keyRequest(path, init)).status, 403);
                assert.equal(t.calls.length, before);
            }
            for (const store of [t.main, t.remote]) assert.equal(store.sqlite.prepare("SELECT count(*) n FROM mail_mutation_jobs").get().n, 0);
        });
    } finally { t.close(); }
});

test("main+shard SQLite preserves pre-cutover primary queue origin and authorizes completed remote jobs", async () => {
    const t = await topology();
    try {
        const addJob = (store, id, account, source, status) => store.sqlite.prepare(`
            INSERT INTO mail_mutation_jobs(id,email_id,account_id,source,to_addr,provider,operation,
                status,attempts,next_attempt_at,created_at,updated_at)
            VALUES (?, 'deleted-message', ?, ?, 'mine@test', 'graph', 'delete', ?, 1, 0, 1, 2)
        `).run(id, account, source, status);
        addJob(t.main, "old-primary-job", "mine", "imap_gmail", "pending");
        addJob(t.main, "victim-primary-job", "other", "imap_qq", "succeeded");
        addJob(t.remote, "remote-job", "mine", "imap_gmail", "succeeded");
        addJob(t.remote, "victim-job", "other", "imap_qq", "succeeded");
        addJob(t.remote, "source-job", "mine", "imap_qq", "succeeded");
        await withFetch(t.fetchRemote, async () => {
            const before = t.calls.length;
            const primaryStatus = await t.request("mutations/old-primary-job");
            assert.equal(primaryStatus.status, 200);
            assert.equal((await primaryStatus.json()).status, "pending");
            assert.equal(t.calls.length, before);
            assert.equal((await t.request("mutations/victim-primary-job")).status, 403);
            const status = await t.request("mutations/remote-job");
            assert.equal(status.status, 200);
            assert.equal((await status.json()).status, "succeeded");
            assert.equal((await t.request("mutations/victim-job")).status, 403);
            assert.equal((await t.request("mutations/source-job", { headers: t.keyHeaders })).status, 403);
            assert.equal((await t.request("mutations/missing")).status, 404);
            const adminRequest = (path, body) => t.app.request("https://gateway.invalid/admin/unified/" + path,
                { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }, t.env);
            const claim = await adminRequest("mutations/v2/claim", { lease_token: "primary-lease", limit: 10 });
            assert.equal(claim.status, 200);
            assert.deepEqual((await claim.json()).jobs.map(job => job.id), ["old-primary-job"]);
            const completed = await adminRequest("mutations/old-primary-job/result", { lease_token: "primary-lease", status: "succeeded" });
            assert.equal(completed.status, 200);
            assert.equal((await (await t.request("mutations/old-primary-job")).json()).status, "succeeded");
            assert.equal(t.remote.sqlite.prepare("SELECT count(*) n FROM mail_mutation_jobs WHERE id='old-primary-job'").get().n, 0);
        });
        await withFetch(async () => { throw Error("offline"); }, async () => {
            assert.equal((await t.request("mutations/old-primary-job")).status, 200);
            const status = await t.request("mutations/remote-job");
            assert.equal(status.status, 503);
            assert.deepEqual((await status.json()).degraded, ["s1"]);
        });
    } finally { t.close(); }
});

test("main+shard SQLite remote failures preserve local success and expose degraded without stale fallback", async () => {
    const t = await topology();
    try {
        for (const failure of [async () => { throw Error("offline"); }, async () => Response.json({ error: "quota exhausted" }, { status: 503 })]) {
            await withFetch(failure, async () => {
                const list = await (await t.request("emails?limit=10")).json();
                assert.deepEqual(list.results.map(row => row.id), ["native", "local"]);
                assert.equal(list.count, null);
                assert.equal(list.has_more, true);
                assert.equal(list.next_cursor, null);
                assert.deepEqual(list.degraded, ["s1"]);
                const codes = await (await t.request("verifcodes?fresh=10")).json();
                assert.deepEqual(codes.results.map(row => row.code).sort(), ["111111", "444444"]);
                assert.deepEqual(codes.degraded, ["s1"]);
                for (const id of ["migrated", "primary-only-copy", "missing"]) {
                    const detail = await t.request(`emails/${id}`);
                    assert.equal(detail.status, 503);
                    assert.deepEqual((await detail.json()).degraded, ["s1"]);
                }
                for (const [action, method, body] of mutationCases) {
                    const response = await t.request(...mutationRequest("migrated", action, method, body));
                    assert.equal(response.status, 503);
                    assert.deepEqual((await response.json()).degraded, ["s1"]);
                }
                assert.equal(t.main.sqlite.prepare("SELECT count(*) n FROM mail_mutation_jobs").get().n, 0);
                const native = await t.request(...mutationRequest("native", "read", "POST"));
                assert.equal(native.status, 200);
                assert.deepEqual(await native.json(), { ok: true, status: "succeeded", operation: "set_read", desired_value: 1, is_read: 1 });
                assert.equal(t.main.sqlite.prepare("SELECT is_read FROM emails WHERE id='native'").get().is_read, 1);
                const local = await t.request(...mutationRequest("local", "star", "POST", { is_starred: 1 }));
                assert.equal(local.status, 202);
                const queued = await local.json();
                assert.equal(queued.degraded, undefined);
                assert.equal(t.main.sqlite.prepare("SELECT account_id FROM mail_mutation_jobs WHERE id=?").get(queued.job_id).account_id, "local-account");
                t.main.sqlite.exec("DELETE FROM mail_mutation_jobs");
            });
        }
        assert.equal(t.remote.sqlite.prepare("SELECT count(*) n FROM mail_mutation_jobs").get().n, 0);
    } finally { t.close(); }
});

test("no count requested means null on every page; counted paged requests keep zero", async () => {
    await withFetch(async () => Response.json({ results: [], count: null }), async () => {
        // 未 opt-in：任何分页形态都不得回一个看起来像「已算出 0」的值。
        for (const offset of [0, 1, undefined]) {
            const response = await federation.federatedListEmails(context(), map, { rest: {}, limit: 1, offset, withCount: false });
            assert.equal((await response.json()).count, null);
        }
        const paged = await federation.federatedListEmails(
            context(), map, { rest: {}, limit: 1, cursor: encodeEmailCursor(1, "x"), withCount: false });
        assert.equal((await paged.json()).count, null);

        // opt-in 后仍然只在首页计数，翻页不回退成 null。
        for (const offset of [1, undefined]) {
            const response = await federation.federatedListEmails(context(), map, { rest: {}, limit: 1, offset, withCount: true });
            assert.equal((await response.json()).count, 0);
        }
    });
});

const fleetMap = {
    v: 1,
    shards: Array.from({ length: 12 }, (_, index) => ({ id: `s${index}`, base_url: `https://s${index}.invalid`, token: "t".repeat(32) })),
    accounts: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`mail${index}`, `s${index}`])),
};
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("twelve-shard list has at most four active fetches and preserves global tie order", async () => {
    const pending = [];
    let active = 0, peak = 0;
    await withFetch(async (url) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => pending.push(resolve));
        active--;
        return Response.json({ results: [{ id: new URL(url).host, received_at: 100 }], count: 1 });
    }, async () => {
        const result = federation.federatedListEmails(context(null, { owned: Object.keys(fleetMap.accounts) }), fleetMap, { rest: {}, limit: 12, withCount: true });
        await nextTurn();
        const firstWave = pending.length;
        while (pending.length) {
            pending.splice(0).forEach(resolve => resolve());
            await nextTurn();
        }
        const body = await (await result).json();
        assert.equal(firstWave, 4);
        assert.equal(peak, 4);
        assert.equal(body.count, 12);
        assert.deepEqual(body.results.map(row => row.id), fleetMap.shards.map(shard => new URL(shard.base_url).host).sort().reverse());
    });
});

test("cancelled gateway requests do not start shard reads", async () => {
    const controller = new AbortController();
    controller.abort();
    const c = context(null, { owned: Object.keys(fleetMap.accounts) });
    c.req.raw = new Request("https://gateway.invalid/emails", { signal: controller.signal });
    let calls = 0;
    await withFetch(async () => { calls++; return Response.json({ results: [], count: 0 }); }, async () => {
        const result = await (await federation.federatedListEmails(c, fleetMap, { rest: {}, limit: 10, withCount: true })).json();
        assert.equal(calls, 0);
        assert.equal(result.incomplete, true);
        assert.equal(result.next_cursor, null);
        assert.equal(result.unavailable_mailbox_ids.length, 12);
    });
});

test("after a partial page the same cursor recovers missing higher-ranked mail", async () => {
    const c = () => context(null, { owned: ["mail0", "mail1"] });
    let outage = true;
    await withFetch(async (url) => {
        if (new URL(url).host === "s1.invalid") return outage ? new Response("offline", { status: 503 }) : Response.json({ results: [{ id: "newer", received_at: 200 }], count: 1 });
        return Response.json({ results: [{ id: "older", received_at: 100 }], count: 1 });
    }, async () => {
        const input = { rest: {}, limit: 1, withCount: true };
        const partial = await (await federation.federatedListEmails(c(), fleetMap, input)).json();
        assert.equal(partial.incomplete, true);
        assert.equal(partial.next_cursor, null);
        assert.deepEqual(partial.results.map(row => row.id), ["older"]);
        outage = false;
        const recovered = await (await federation.federatedListEmails(c(), fleetMap, input)).json();
        assert.equal(recovered.incomplete, false);
        assert.deepEqual(recovered.results.map(row => row.id), ["newer"]);
        assert.equal(typeof recovered.next_cursor, "string");
        assert.equal(recovered.count, 2);
    });
});

test("legacy deep offsets use bounded remote pages without skipping the dominant shard", async () => {
    const rows = Array.from({ length: 700 }, (_, index) => ({ id: `id${String(index).padStart(4, "0")}`, received_at: 1000 - index }));
    const requests = [];
    await withFetch(async (_url, init) => {
        const query = JSON.parse(init.body);
        requests.push(query);
        const cursor = query.cursor ? JSON.parse(Buffer.from(query.cursor, "base64url").toString()) : null;
        const after = cursor ? rows.filter(row => row.received_at < cursor.sortKey) : rows;
        const page = after.slice(0, query.limit);
        const last = page.at(-1);
        return Response.json({ results: page, count: query.with_count ? rows.length : 0, has_more: after.length > page.length,
            next_cursor: after.length > page.length ? Buffer.from(JSON.stringify({ v: 1, sortKey: last.received_at, id: last.id })).toString("base64url") : null });
    }, async () => {
        const result = await (await federation.federatedListEmails(context(), map, { rest: {}, offset: 500, limit: 100, withCount: false })).json();
        assert.deepEqual(result.results, rows.slice(500, 600));
        assert.ok(requests.every(query => query.limit <= 100));
        assert.equal(requests.length, 6);
        assert.ok(requests.every(query => query.offset === undefined));
    });
});

test("oversized list and malformed order cannot advance the pagination boundary", async () => {
    const responses = [
        { results: [{ id: "large", received_at: 1, subject: "x".repeat(512 * 1024) }], count: 1 },
        { results: [{ id: "older", received_at: 1 }, { id: "newer", received_at: 2 }], count: 2 },
        { results: [{ id: "same", received_at: 1 }, { id: "same", received_at: 1 }], count: 2 },
    ];
    for (const response of responses) await withFetch(async () => Response.json(response), async () => {
        const body = await (await federation.federatedListEmails(context(), map, { rest: {}, limit: 10, withCount: true })).json();
        assert.equal(body.incomplete, true);
        assert.equal(body.count, null);
        assert.equal(body.next_cursor, null);
        assert.deepEqual(body.unavailable_mailbox_ids, ["mine"]);
        assert.deepEqual(body.results, []);
    });
});

test("all lookup and extra endpoint fanouts respect four active shards", async () => {
    for (const endpoint of [
        (c, registry) => federation.fanOutGet(c, registry, "/shard/emails/missing"),
        federation.federatedStats, federation.federatedCount, federation.federatedMeta,
    ]) {
        const pending = [];
        let active = 0, peak = 0;
        await withFetch(async (url) => {
            active++; peak = Math.max(peak, active);
            await new Promise(resolve => pending.push(resolve)); active--;
            return new URL(url).pathname.includes("emails")
                ? Response.json({ error: "not found" }, { status: 404 })
                : Response.json({ count: 1, unread: 0, sources: [], accounts: [], to_addrs: [] });
        }, async () => {
            const task = endpoint(context(null, { owned: Object.keys(fleetMap.accounts) }), fleetMap);
            await nextTurn();
            while (pending.length) { pending.splice(0).forEach(resolve => resolve()); await nextTurn(); }
            await task;
            assert.equal(peak, 4);
        });
    }
});

for (const [orphanAccount, expectedStatus] of [["mine", 202], ["spare", 409]]) test(
    `duplicate id with account ${orphanAccount} returns ${expectedStatus} and never writes two owners`, async () => {
    const t = await topology();
    const orphan = sqliteD1();
    try {
        await initializeShardSchema(orphan.database);
        orphan.sqlite.prepare(`INSERT INTO emails(id,source,account_id,from_addr,to_addr,received_at,provider,provider_message_id)
            VALUES ('migrated','imap_gmail',?,'sender','mine@test',1,'graph','old-provider-copy')`).run(orphanAccount);
        t.main.sqlite.exec("INSERT INTO user_mail_accounts VALUES ('spare',1)");
        const registry = { ...map, shards: [...map.shards, { ...map.shards[0], id: "s2", base_url: "https://orphan.invalid" }],
            accounts: { ...map.accounts, spare: "s2" } };
        const { app, env } = gateway(t.main.database, registry);
        const writes = [];
        await withFetch((url, init) => {
            if (init.method !== "GET") writes.push(new URL(url).host);
            const DB = new URL(url).host === "orphan.invalid" ? orphan.database : t.remote.database;
            return shardRoutes.fetch(new Request(url, init), { DB, SHARD_TOKEN: map.shards[0].token });
        }, async () => {
            const response = await app.request("https://gateway.invalid/api/unified/emails/migrated/read", { headers, method: "POST" }, env);
            assert.equal(response.status, expectedStatus);
            assert.deepEqual(writes, expectedStatus === 202 ? ["shard.invalid"] : []);
            assert.equal(orphan.sqlite.prepare("SELECT count(*) n FROM mail_mutation_jobs").get().n, 0);
            assert.equal(t.remote.sqlite.prepare("SELECT count(*) n FROM mail_mutation_jobs").get().n, expectedStatus === 202 ? 1 : 0);
        });
    } finally { orphan.sqlite.close(); t.close(); }
});

test("locator rejects a successful response for another email id before any mutation", async () => {
    const { app, env } = gateway(db());
    let writes = 0;
    await withFetch(async (_url, init) => {
        if (init.method === "GET") return Response.json({ id: "other-id", account_id: "mine", source: "imap_gmail" });
        writes++;
        return Response.json({ ok: true, status: "queued" }, { status: 202 });
    }, async () => {
        const response = await app.request("https://gateway.invalid/api/unified/emails/expected-id/read", { headers, method: "POST" }, env);
        assert.equal(response.status, 503);
        assert.equal(writes, 0);
    });
});

test("locator and mutation share one deadline including time between both phases", async (t) => {
    let now = 0;
    t.mock.method(performance, "now", () => now);
    const c = context();
    c.req.param = () => "expected-id";
    let writes = 0;
    await withFetch(async (_url, init) => {
        if (init.method === "GET") return Response.json({ id: "expected-id", account_id: "mine", source: "imap_gmail" });
        writes++;
        return Response.json({ ok: true }, { status: 202 });
    }, async () => {
        const owner = await federation.locateRemoteEmailOwner(c, map, "/shard/emails/expected-id");
        assert.equal(owner.shard.id, "s1");
        now = 3001;
        const response = await federation.applyToShard(c, map, owner.shard, "/shard/emails/expected-id/read", { method: "POST" }, owner);
        assert.equal(response.status, 503);
        assert.equal(writes, 0);
    });
});

test("locator and mutation share the retained response budget", async () => {
    const c = context();
    c.req.param = () => "expected-id";
    await withFetch(async (_url, init) => init.method === "GET"
        ? Response.json({ id: "expected-id", account_id: "mine", source: "imap_gmail", text_body: "x".repeat(4 * 1024 * 1024) })
        : Response.json({ ok: true, provider_diagnostic: "x".repeat(5 * 1024 * 1024) }, { status: 202 }), async () => {
        const owner = await federation.locateRemoteEmailOwner(c, map, "/shard/emails/expected-id");
        const response = await federation.applyToShard(c, map, owner.shard, "/shard/emails/expected-id/read", { method: "POST" }, owner);
        assert.equal(response.status, 503);
    });
});

test("single owner mutation rechecks permissions and narrows its scope to the located mailbox", async () => {
    const owned = ["mine", "other"];
    const c = context(null, { owned });
    c.req.param = () => "id";
    const writeScopes = [];
    await withFetch(async (_url, init) => {
        if (init.method === "GET") return Response.json({ id: "id", account_id: "mine", source: "imap_gmail" });
        writeScopes.push(JSON.parse(decodeURIComponent(init.headers["x-one-mail-shard-scope"])));
        return Response.json({ ok: true }, { status: 202 });
    }, async () => {
        const owner = await federation.locateRemoteEmailOwner(c, map, "/shard/emails/id");
        const result = await federation.applyToShard(c, map, owner.shard, "/shard/emails/id/read", { method: "POST" }, owner);
        assert.equal(result.status, 202);
        assert.deepEqual(writeScopes, [{ account_ids: ["mine"], sources: null }]);
        owned.splice(0, 1);
        const denied = await federation.applyToShard(c, map, owner.shard, "/shard/emails/id/read", { method: "POST" }, owner);
        assert.equal(denied.status, 403);
        assert.equal(writeScopes.length, 1);
        const movedMap = { ...map, accounts: { ...map.accounts, mine: "s2" } };
        assert.equal((await federation.applyToShard(c, movedMap, owner.shard, "/shard/emails/id/read", { method: "POST" }, owner)).status, 409);
        assert.equal(writeScopes.length, 1);
    });
});
