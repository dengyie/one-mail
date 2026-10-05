import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { ingestHandler } from "./ingest.ts";
import { ARCHIVE_EMAIL_COLUMNS } from "./archival_ingest.ts";
import { resetShardMapCacheForTests } from "./shard_map.ts";

const email = (account_id, source = "imap_qq") => ({ source, account_id, from_addr: "a@b", to_addr: "c@d" });
function fixture(map = null, shard = false) {
    resetShardMapCacheForTests();
    const writes = [];
    const db = { prepare: sql => ({ bind: (...params) => ({ sql, params }) }), async batch(statements) {
        writes.push(...statements); return statements.map(() => ({ meta: { changes: 1 } }));
    } };
    const app = new Hono();
    app.post("/ingest", ingestHandler);
    const env = { DB: db, KV: { get: async () => map && JSON.stringify(map) }, SHARD_MODE: shard ? "1" : "0" };
    return { writes, request: body => app.request("/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, env) };
}
const registry = { v: 1, shards: [{ id: "s1", base_url: "https://shard.invalid", token: "t".repeat(32) }], accounts: { moved: "s1" } };
test("empty registry ingest keeps the established acknowledgement", async () => {
    const f = fixture();
    assert.deepEqual(await (await f.request({ emails: [email("local")] })).json(), { inserted: 1, skipped: 0, folders_upserted: 0 });
    assert.equal(f.writes.length, 1);
});
test("primary splits email and folder writes; native email stays local", async () => {
    const f = fixture(registry);
    const original = globalThis.fetch;
    const uploads = [];
    globalThis.fetch = async (url, options) => {
        assert.equal(url, "https://shard.invalid/shard/ingest");
        assert.equal(options.headers.authorization, `Bearer ${"t".repeat(32)}`);
        const body = JSON.parse(options.body); uploads.push(body);
        return Response.json({ inserted: body.emails.length, skipped: 0, folders_upserted: body.folders.length });
    };
    try {
        const response = await f.request({ emails: [email("moved"), email("moved", "cf_routing"), email("local")], folders: [{ account_id: "moved", provider: "imap", canonical_name: "INBOX" }] });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { inserted: 3, skipped: 0, folders_upserted: 1 });
        assert.deepEqual(uploads[0].emails.map(row => row.source), ["imap_qq"]);
        assert.equal(uploads[0].folders.length, 1);
        assert.deepEqual(f.writes.map(row => row.params[1]), ["cf_routing", "imap_qq"]);
    } finally { globalThis.fetch = original; }
});
test("malformed acknowledgement with impossible folder count fails closed", async () => {
    const original = globalThis.fetch;
    try {
        const f = fixture(registry);
        globalThis.fetch = async () => Response.json({ inserted: 1, skipped: 0, folders_upserted: 99 });
        const response = await f.request({ emails: [email("moved")] });
        assert.equal(response.status, 503);
        assert.equal(f.writes.length, 0);
    } finally { globalThis.fetch = original; }
});

test("remote error and malformed acknowledgements never fall back or acknowledge success", async () => {
    const original = globalThis.fetch;
    try {
        for (const reply of [Response.json({ error: "unavailable" }, { status: 503 }), Response.json({ inserted: 0, skipped: 0, folders_upserted: 0 })]) {
            const f = fixture(registry);
            globalThis.fetch = async () => reply;
            assert.equal((await f.request({ emails: [email("moved")] })).status, 503);
            assert.equal(f.writes.length, 0);
        }
    } finally { globalThis.fetch = original; }
});
test("validation precedes writes and archive mode requires shard mode", async () => {
    const f = fixture();
    for (const body of [null, [], { emails: [email("local")], folders: [{}] }, { emails: [email("local"), null] }, { emails: [email("local")], migration: true }]) {
        assert.equal((await f.request(body)).status, 400);
        assert.equal(f.writes.length, 0);
    }
    const shard = fixture(null, true);
    assert.equal((await shard.request({ emails: [email("local", "cf_routing")] })).status, 400);
});
test("archive batches preserve every nullable column and do not refresh provider state", async () => {
    const f = fixture(null, true);
    const row = Object.fromEntries(ARCHIVE_EMAIL_COLUMNS.map(column => [column, null]));
    Object.assign(row, email("moved"), { id: "original", received_at: 123, is_read: 1, is_starred: 1 });
    const response = await f.request({ migration: true, emails: [row] });
    assert.equal(response.status, 200);
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.writes[0].params, ARCHIVE_EMAIL_COLUMNS.map(column => row[column]));
    assert.match(f.writes[0].sql, /^INSERT OR IGNORE/);
    delete row.updated_at;
    assert.equal((await f.request({ migration: true, emails: [row] })).status, 400);
    assert.equal(f.writes.length, 1);
});
