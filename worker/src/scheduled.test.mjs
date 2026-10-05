import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
// Isolate cron orchestration: retention SQL has its own unit tests. Use actual SQLite locking.
globalThis.shardCronScans = 0;
globalThis.shardCronFailure = false;
registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL?.endsWith("/scheduled.ts")) {
        const replacements = {
            "./common": "export const cleanup=async()=>{throw new Error('legacy forbidden')}",
            "./utils": "export const getJsonSettingStrict=async()=>{if(globalThis.shardCronSettingsFailure)throw new Error('settings unavailable');return globalThis.shardCronSetting ?? null}",
            "./models": "export const CleanupSettings={}",
            "./admin_api/cleanup_api": "export const executeCustomSqlCleanup=async()=>{}",
            "./mails_api/send_mail_limit_utils": "export const reconcileSendMailLimitReservations=async()=>{throw new Error('sendbox forbidden')};export const countUnknownSendMailReservations=async()=>0",
            "./unified/retention": "export const purgeOldEmailBodies=async()=>{globalThis.shardCronScans++;if(globalThis.shardCronFailure)throw new Error('retention failed');return{purged:0}};export const cleanupReadEmails=async()=>{globalThis.shardCronScans++;return{deleted:0}}",
        };
        if (replacements[specifier]) return { url: `data:text/javascript,${encodeURIComponent(replacements[specifier])}`, shortCircuit: true };
    }
    if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context);
    return next(specifier, context);
} });
const { scheduled } = await import("./scheduled.ts");
function fixture({ shardMode = true } = {}) {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE scheduled_locks(name TEXT PRIMARY KEY,owner TEXT NOT NULL,locked_until INTEGER NOT NULL)");
    const store = new Map();
    const env = {
        SHARD_MODE: "1", SHARD_ID: "shard1",
        DB: { prepare(sql) { let args = []; return { bind(...values) { args = values; return this; }, async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; } }; } },
        KV: { get: async key => store.get(key) ?? null, put: async (key, value) => { store.set(key, value); } },
    };
    globalThis.shardCronScans = 0;
    globalThis.shardCronFailure = false;
    globalThis.shardCronSettingsFailure = false;
    globalThis.shardCronSetting = null;
    if (!shardMode) delete env.SHARD_MODE;
    return { sqlite, env, store, lockCount: () => sqlite.prepare("SELECT count(*) n FROM scheduled_locks").get().n };
}
test("shard cron writes suffixed markers, skips legacy tables, and respects success cooldown", async () => {
    const f = fixture();
    await scheduled({}, f.env, {});
    assert.equal(globalThis.shardCronScans, 2);
    assert.ok(f.store.has("one-mail:retention:last-success:shard1"));
    assert.ok(f.store.has("one-mail:retention:last-attempt:shard1"));
    assert.equal(f.lockCount(), 0);
    await scheduled({}, f.env, {});
    assert.equal(globalThis.shardCronScans, 2);
    assert.equal(f.lockCount(), 0);
    f.sqlite.close();
});
test("failed retention preserves attempt cooldown and releases owner lock", async () => {
    const f = fixture();
    globalThis.shardCronFailure = true;
    await scheduled({}, f.env, {});
    assert.ok(f.store.has("one-mail:retention:last-attempt:shard1"));
    assert.ok(!f.store.has("one-mail:retention:last-success:shard1"));
    assert.equal(f.lockCount(), 0);
    await scheduled({}, f.env, {});
    assert.equal(globalThis.shardCronScans, 1);
    f.sqlite.close();
});
test("scheduled settings read failure does not write a success marker", async () => {
    const f = fixture({ shardMode: false });
    globalThis.shardCronSettingsFailure = true;
    await scheduled({}, f.env, {});
    assert.ok(f.store.has("one-mail:retention:last-attempt"));
    assert.ok(!f.store.has("one-mail:retention:last-success"));
    assert.equal(globalThis.shardCronScans, 2);
    assert.equal(f.lockCount(), 0);
    f.sqlite.close();
});
test("KV marker write failure prevents scans and still releases lock", async () => {
    const f = fixture();
    f.env.KV.put = async () => { throw new Error("KV unavailable"); };
    await scheduled({}, f.env, {});
    assert.equal(globalThis.shardCronScans, 0);
    assert.equal(f.lockCount(), 0);
    f.sqlite.close();
});
test("live peer lock prevents scans and is not deleted by this cron", async () => {
    const f = fixture();
    f.sqlite.prepare("INSERT INTO scheduled_locks VALUES(?,?,?)").run("one-mail:retention:shard1", "peer", Date.now() + 60000);
    await scheduled({}, f.env, {});
    assert.equal(globalThis.shardCronScans, 0);
    assert.equal(f.sqlite.prepare("SELECT owner FROM scheduled_locks").get().owner, "peer");
    f.sqlite.close();
});
