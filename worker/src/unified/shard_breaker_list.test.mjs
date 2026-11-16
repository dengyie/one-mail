import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import ts from "typescript";

// P4 熔断与统一收件箱列表路径的集成回归（自 federation.test.mjs 拆出，
// 行数预算门）。harness 与 federation.test.mjs 同构：真实路由 + 扩展名
// 解析钩子，只有外部边界打桩。
const commonUrl = new URL("../common.ts", import.meta.url).href;
const utilsUrl = new URL("../utils.ts", import.meta.url).href;
const accountsUrl = new URL("../user_api/mail_accounts.ts", import.meta.url).href;
const commonSource = (await import("node:fs")).readFileSync(new URL(commonUrl), "utf8");
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
        if (url === commonUrl) source = `const i18n = { getMessagesbyContext: () => ({}) }; const hideObjectFields=x=>x; export const commonGetUserRole=async()=>null; ${listSource}`;
        if (url === utilsUrl) source = "export const checkIsAdmin=async()=>false;";
        if (url === accountsUrl) source = "export default {};";
        if (source === undefined) return next(url, context);
        return { format: "module", source: ts.transpile(source, { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext }), shortCircuit: true };
    },
});
const federation = await import("./federation.ts");
const { resetShardMapCacheForTests } = await import("./shard_map.ts");
const breakerMod = await import("./shard_breaker.ts");
hooks.deregister();

const map = { v: 1, shards: [{ id: "s1", base_url: "https://shard.invalid", token: "t".repeat(32) }], accounts: { mine: "s1", other: "s1" } };
const user = { userPayload: { user_id: 1, exp: 9999999999 }, isAdmin: false, userRole: null };
function db() {
    return {
        prepare(sql) {
            let params = [];
            return {
                bind(...values) { params = values; return this; },
                async all() { return { results: sql.includes("SELECT id FROM user_mail_accounts") ? [{ id: "mine" }] : [] }; },
                async first(column) { return column ? 0 : { count: 0, unread: 0 }; },
                async run() { return { success: true }; },
            };
        },
        async batch() { return []; },
    };
}
async function withFetch(impl, run) {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try { return await run(); } finally { globalThis.fetch = original; }
}
const breakerContext = (database, kv) => ({
    env: { DB: database, KV: kv },
    get: name => name === "apiKey" ? null : name === "unifiedUserAuth" ? user : undefined,
    req: { query: () => undefined },
    json: (body, status = 200) => Response.json(body, { status }),
});
const snapshotStore = () => {
    const store = new Map();
    return { store, kv: {
        get: async (key) => key === "one-mail:shard-map" ? JSON.stringify(map) : (store.get(key) ?? null),
        put: async (key, value) => { store.set(key, String(value)); },
    } };
};
const quotaResponse = (pct) => Response.json({ shard_id: "s1", rows_read_pct: pct, rows_written_pct: 1 });

test("P4 stale 档：90%+ 分片的列表读切 KV 快照（延迟可见），不再发起 /shard/emails", async () => {
    breakerMod.resetShardBreakerCacheForTests();
    breakerMod.resetShardSnapshotThrottleForTests();
    const { store, kv } = snapshotStore();
    const fingerprint = breakerMod.snapshotFingerprint({ account_ids: ["mine"], sources: null }, {}, 2);
    store.set(breakerMod.snapshotKey("s1", fingerprint), JSON.stringify({
        rows: [{ id: "stale-1", received_at: 500 }], saved_at: 1,
    }));
    const calls = [];
    await withFetch(async (url) => {
        calls.push(String(url));
        if (String(url).includes("/shard/quota")) return quotaResponse(95);
        throw new Error("stale 分片不该被请求: " + url);
    }, async () => {
        const response = await federation.federatedListEmails(
            breakerContext(db(), kv), map, { rest: {}, limit: 1, withCount: true });
        const body = await response.json();
        assert.deepEqual(calls.filter(url => url.includes("/shard/emails")), [], "stale 分片不得发起列表请求");
        assert.deepEqual(body.results.map(row => row.id), ["stale-1"], "快照行必须延迟可见");
        assert.equal(body.count, null);
        assert.equal(body.incomplete, true);
        assert.equal(body.has_more, true);
        assert.deepEqual(body.stale, ["s1"]);
        assert.deepEqual(body.degraded, []);
    });
});

test("P4 degraded 档：80%+ 关远端 COUNT（列表继续、快照照常刷新）", async () => {
    breakerMod.resetShardBreakerCacheForTests();
    breakerMod.resetShardSnapshotThrottleForTests();
    const { store, kv } = snapshotStore();
    const bodies = [];
    let puts = 0;
    const kvCounting = { ...kv, put: async (key, value) => { puts++; store.set(key, String(value)); } };
    await withFetch(async (url, init) => {
        if (String(url).includes("/shard/quota")) return quotaResponse(85);
        if (String(url).includes("/shard/emails")) {
            bodies.push(JSON.parse(init.body));
            return Response.json({ results: [{ id: "live-1", received_at: 200 }], count: 7, has_more: false });
        }
        throw new Error("unexpected fetch " + url);
    }, async () => {
        const response = await federation.federatedListEmails(
            breakerContext(db(), kvCounting), map, { rest: {}, limit: 1, withCount: true });
        const body = await response.json();
        assert.equal(bodies[0].with_count, 0, "degraded 分片的远端 COUNT 必须关闭");
        assert.equal(body.incomplete, false);
        assert.equal(body.stale, undefined);
        assert.equal(puts, 1, "成功页必须落一次快照（节流内仅一次）");
    });
});

test("P4 stale 无快照 → 按不可达降级（unavailable + incomplete）", async () => {
    breakerMod.resetShardBreakerCacheForTests();
    breakerMod.resetShardSnapshotThrottleForTests();
    const { kv } = snapshotStore();
    await withFetch(async (url) => {
        if (String(url).includes("/shard/quota")) return quotaResponse(95);
        throw new Error("stale 分片不该被请求: " + url);
    }, async () => {
        const response = await federation.federatedListEmails(
            breakerContext(db(), kv), map, { rest: {}, limit: 1, withCount: true });
        const body = await response.json();
        assert.equal(body.count, null);
        assert.equal(body.incomplete, true);
        assert.deepEqual(body.unavailable_mailbox_ids, ["mine"]);
        assert.deepEqual(body.stale, undefined);
        assert.deepEqual(body.degraded, ["s1"]);
    });
});
