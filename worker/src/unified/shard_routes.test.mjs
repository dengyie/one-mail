import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";

// Match bundler resolution without loading unrelated mail/sending integrations.
registerHooks({ resolve(specifier, context, next) {
    if (specifier === "../common") return { url: "data:text/javascript,export const handleListQuery=()=>{throw new Error('unused')}", shortCircuit: true };
    if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context);
    return next(specifier, context);
} });
const { default: routes } = await import("./shard_routes.ts");
const { initializeShardSchema } = await import("./shard_schema.ts");
const TOKEN = "s".repeat(32);
async function fixture() {
    const sqlite = new DatabaseSync(":memory:");
    const bindings = [];
    const db = {
        async exec(sql) { sqlite.exec(sql); },
        prepare(sql) {
            let args = [];
            return {
                bind(...values) { args = values; bindings.push(values); return this; },
                async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; },
                async all() { return { results: sqlite.prepare(sql).all(...args) }; },
                async first(column) { const row = sqlite.prepare(sql).get(...args) ?? null; return column ? row?.[column] ?? null : row; },
            };
        },
        async batch(statements) { return Promise.all(statements.map(statement => statement.run())); },
    };
    await initializeShardSchema(db);
    sqlite.exec(`INSERT INTO emails(id,source,account_id,from_addr,to_addr,received_at,provider,provider_message_id)
      VALUES ('a','imap_qq','acctA','sender@example','mine@example',1,'graph','pa'),
             ('a-other-source','graph_outlook','acctA','sender@example','mine@example',2,'graph','pc'),
             ('b','graph_outlook','acctB','sender@example','victim@example',3,'graph','pb')`);
    const scope = { account_ids: ["acctA"], sources: ["imap_qq"] };
    const request = (path, { method = "GET", body, scope: requestedScope = scope, auth = TOKEN } = {}) => {
        const headers = { authorization: `Bearer ${auth}`, "content-type": "application/json" };
        if (requestedScope !== undefined) headers["x-one-mail-shard-scope"] = encodeURIComponent(JSON.stringify(requestedScope));
        return routes.fetch(new Request(`https://shard.example${path}`, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }), { DB: db, SHARD_TOKEN: TOKEN, SHARD_MODE: "1", SHARD_ID: "shard1" });
    };
    return { sqlite, db, bindings, request, scope };
}
test("row routes require scope and reject cross-account and cross-source reads/mutations", async () => {
    const f = await fixture();
    const noScope = new Request("https://shard.example/shard/emails/a", { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal((await routes.fetch(noScope, { DB: f.db, SHARD_TOKEN: TOKEN })).status, 403);
    for (const id of ["b", "a-other-source"]) {
        assert.equal((await f.request(`/shard/emails/${id}`)).status, 403);
        for (const [method, suffix] of [["DELETE", ""], ["POST", "/read"], ["POST", "/move"]]) {
            assert.equal((await f.request(`/shard/emails/${id}${suffix}`, { method, body: method === "POST" ? {} : undefined })).status, 403);
        }
    }
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM mail_mutation_jobs").get().n, 0);
    assert.equal((await f.request("/shard/emails/a")).status, 200);
    f.sqlite.close();
});
test("scoped delete queues only the owned email and job status honors snapshot scope", async () => {
    const f = await fixture();
    const response = await f.request("/shard/emails/a", { method: "DELETE" });
    assert.equal(response.status, 202);
    const { job_id } = await response.json();
    assert.equal((await f.request(`/shard/mutations/${job_id}`)).status, 200);
    assert.equal((await f.request(`/shard/mutations/${job_id}`, { scope: { account_ids: ["acctB"], sources: null } })).status, 403);
    f.sqlite.close();
});
test("meta and list preserve account/source scope; empty scope is empty", async () => {
    const f = await fixture();
    assert.deepEqual(await (await f.request("/shard/meta?account_id=acctA")).json(), { sources: ["imap_qq"], accounts: ["acctA"], to_addrs: ["mine@example"] });
    const list = await f.request("/shard/emails", { method: "POST", body: { limit: 20, account_ids: ["acctA", "acctB"], with_count: 0 } });
    assert.equal(list.status, 200);
    assert.deepEqual((await list.json()).results.map(row => row.id), ["a"]);
    assert.deepEqual(await (await f.request("/shard/meta", { scope: { account_ids: [], sources: null } })).json(), { sources: [], accounts: [], to_addrs: [] });
    assert.equal((await f.request("/shard/meta?account_id=acctB")).status, 403);
    f.sqlite.close();
});
test("typed DTO rejects malformed bodies/fields and account lists use bounded JSON binding", async () => {
    const f = await fixture();
    const admin = { account_ids: null, sources: null };
    for (const body of ["{", "null", "[]", { limit: 20, source: [] }, { limit: 20, account_ids: [1] }]) {
        assert.equal((await f.request("/shard/emails", { method: "POST", body, scope: admin })).status, 400);
    }
    assert.equal((await f.request("/shard/accounts/purge", { method: "POST", body: "null", scope: admin })).status, 400);
    const response = await f.request("/shard/emails", { method: "POST", body: { limit: 20, account_ids: Array.from({ length: 150 }, (_, i) => `acct${i}`), with_count: 0 }, scope: admin });
    assert.equal(response.status, 200);
    assert.ok(f.bindings.every(args => args.length < 100));
    f.sqlite.close();
});
test("150-account/source scope headers keep meta and folders bounded and intersect source", async () => {
    const f = await fixture();
    f.sqlite.exec(`INSERT INTO mail_account_folders(mail_account_id,provider,canonical_name,folder_type,created_at,updated_at)
        VALUES ('acctA','graph','INBOX','inbox',1,1), ('acctB','graph','INBOX','inbox',1,1)`);
    const scope = {
        account_ids: ["acctA", ...Array.from({ length: 149 }, (_, i) => `extra${i}`)],
        sources: ["imap_qq", ...Array.from({ length: 149 }, (_, i) => `source${i}`)],
    };
    f.bindings.length = 0;
    assert.deepEqual(await (await f.request("/shard/meta", { scope })).json(), {
        sources: ["imap_qq"], accounts: ["acctA"], to_addrs: ["mine@example"],
    });
    const folders = await f.request("/shard/folders", { scope });
    assert.equal(folders.status, 200);
    assert.deepEqual((await folders.json()).results.map(row => row.account_id), ["acctA"]);
    const narrowed = await f.request("/shard/folders?source=source0", { scope });
    assert.deepEqual((await narrowed.json()).results, []);
    assert.equal((await f.request("/shard/folders?source=graph_outlook", { scope })).status, 403);
    assert.ok(f.bindings.every(args => args.length <= 2));
    f.sqlite.close();
});
test("malformed scope and escaped IDs cannot bypass row authorization", async () => {
    const f = await fixture();
    assert.equal((await f.request("/shard/emails/%62")).status, 403);
    assert.equal((await f.request("/shard/emails/a", { scope: {} })).status, 400);
    f.sqlite.close();
});
test("route errors return generic JSON without D1 details", async () => {
    const f = await fixture();
    f.db.prepare = () => { throw new Error("private DB diagnostic"); };
    const response = await f.request("/shard/emails/a");
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "shard request failed" });
    f.sqlite.close();
});
test("archival ingest is exact and replay cannot overwrite live user state", async () => {
    const f = await fixture();
    const { ARCHIVE_EMAIL_COLUMNS, ARCHIVE_FOLDER_COLUMNS } = await import("./archival_ingest.ts");
    const row = Object.fromEntries(ARCHIVE_EMAIL_COLUMNS.map(column => [column, null]));
    Object.assign(row, { id: "historic", source: "imap_qq", account_id: "acctA", from_addr: "sender", to_addr: "receiver", received_at: 12, is_read: 1, is_starred: 1, provider: "imap", source_folder: "INBOX", source_key: "stable" });
    const folder = Object.fromEntries(ARCHIVE_FOLDER_COLUMNS.map(column => [column, null]));
    Object.assign(folder, { mail_account_id: "acctA", provider: "imap", canonical_name: "INBOX", folder_type: "inbox", created_at: 2, updated_at: 3, last_cursor: "42", last_error: "historical error" });
    const upload = () => f.request("/shard/ingest", { method: "POST", body: { migration: true, emails: [row], folders: [folder] } });
    const first = await upload();
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { inserted: 1, skipped: 0, folders_upserted: 1 });
    const stored = f.sqlite.prepare(`SELECT ${ARCHIVE_EMAIL_COLUMNS.join(",")} FROM emails WHERE id='historic'`).get();
    assert.deepEqual({ ...stored }, row);
    const catalog = f.sqlite.prepare(`SELECT ${ARCHIVE_FOLDER_COLUMNS.join(",")} FROM mail_account_folders WHERE mail_account_id='acctA'`).get();
    assert.deepEqual({ ...catalog }, folder);
    f.sqlite.exec("UPDATE emails SET is_read=0,is_starred=0,source_folder='Archive',updated_at=99 WHERE id='historic'");
    assert.deepEqual(await (await upload()).json(), { inserted: 0, skipped: 1, folders_upserted: 0 });
    assert.deepEqual({ ...f.sqlite.prepare("SELECT is_read,is_starred,source_folder,updated_at FROM emails WHERE id='historic'").get() }, { is_read: 0, is_starred: 0, source_folder: "Archive", updated_at: 99 });
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM mail_mutation_jobs").get().n, 0);
    f.sqlite.close();
});

test("schema initializes all thin tables idempotently and retains D1 cause", async () => {
    const f = await fixture();
    await initializeShardSchema(f.db);
    const tables = f.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
    for (const name of ["emails", "mail_account_folders", "mail_mutation_jobs", "scheduled_locks"]) assert.ok(tables.includes(name));
    for (const name of ["users", "settings", "sendbox", "raw_mails"]) assert.ok(!tables.includes(name));
    const cause = new Error("D1 unavailable");
    await assert.rejects(initializeShardSchema({ exec: async () => { throw cause; } }), error => error.cause === cause);
    f.sqlite.close();
});
