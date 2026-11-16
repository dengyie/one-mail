import assert from "node:assert/strict";
import test from "node:test";

import {
    breakerStateFor, getShardBreakerModes, loadShardSnapshot, resetShardBreakerCacheForTests,
    resetShardSnapshotThrottleForTests, resolveBreakerThresholds, saveShardSnapshot,
    snapshotFingerprint, snapshotKey,
} from "./shard_breaker.ts";

const shard = { id: "s1", name: "one_mail_shard1", base_url: "https://shard.invalid", token: "t".repeat(32) };

test("阈值解析：默认 80/90；stale 永不低于 degrade；字符串可解析", () => {
    const d = resolveBreakerThresholds(undefined);
    assert.deepEqual({ degradePct: d.degradePct, stalePct: d.stalePct }, { degradePct: 80, stalePct: 90 });
    assert.deepEqual(
        (() => { const t = resolveBreakerThresholds({ SHARD_BREAKER_DEGRADE_PCT: "70", SHARD_BREAKER_STALE_PCT: "60" }); return [t.degradePct, t.stalePct]; })(),
        [70, 70],
    );
});

test("档位判定：80/90 边界 + fail-open（未知 → normal）", () => {
    const t = resolveBreakerThresholds(undefined);
    assert.equal(breakerStateFor(79.9, t), "normal");
    assert.equal(breakerStateFor(80, t), "degraded");
    assert.equal(breakerStateFor(89.9, t), "degraded");
    assert.equal(breakerStateFor(90, t), "stale");
    assert.equal(breakerStateFor(100, t), "stale");
    assert.equal(breakerStateFor(null, t), "normal");
    assert.equal(breakerStateFor(Number.NaN, t), "normal");
});

test("getShardBreakerModes：配额自报 → 档位；isolate 缓存 60s 内不重发请求", async () => {
    resetShardBreakerCacheForTests();
    let quotaCalls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
        if (String(url).includes("/shard/quota")) {
            quotaCalls++;
            return Response.json({ shard_id: "s1", rows_read_pct: 92, rows_written_pct: 1 });
        }
        throw new Error("unexpected fetch " + url);
    };
    try {
        const modes = await getShardBreakerModes({}, [shard]);
        assert.equal(modes.get("s1"), "stale");
        const cached = await getShardBreakerModes({}, [shard]);
        assert.equal(cached.get("s1"), "stale");
        assert.equal(quotaCalls, 1, "60s 缓存窗口内不得重发 /shard/quota");
    } finally {
        globalThis.fetch = original;
        resetShardBreakerCacheForTests();
    }
});

test("getShardBreakerModes：不可达 / payload 非法 / shard_id 不符 → fail-open normal", async () => {
    resetShardBreakerCacheForTests();
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
        if (String(url).includes("/shard/quota")) return Response.json({ shard_id: "someone-else", rows_read_pct: 99 });
        throw new Error("unexpected fetch " + url);
    };
    try {
        const modes = await getShardBreakerModes({}, [shard]);
        assert.equal(modes.get("s1"), "normal");
    } finally {
        globalThis.fetch = original;
        resetShardBreakerCacheForTests();
    }
});

test("快照存取 + 512KiB 截行 + 写节流（KV 写预算）", async () => {
    resetShardSnapshotThrottleForTests();
    const store = new Map();
    const env = { KV: { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, String(v)); } } };
    const key = snapshotKey("s1", snapshotFingerprint({ account_ids: ["mine"], sources: null }, {}, 20));
    const rows = [{ id: "a", received_at: 100 }, { id: "b", received_at: 90 }];
    await saveShardSnapshot(env, key, rows, 1_000);
    const snap = await loadShardSnapshot(env, key);
    assert.equal(snap.rows.length, 2);
    assert.equal(snap.saved_at, 1_000);
    // 节流：300s 内第二次写被跳过
    await saveShardSnapshot(env, key, [{ id: "c", received_at: 80 }], 2_000);
    assert.equal((await loadShardSnapshot(env, key)).rows.length, 2, "节流窗口内的重写必须被跳过");
    // 超大行集：截行到能放下为止（40×~30KB → 逐半减到 ≤512KiB）
    const many = Array.from({ length: 40 }, (_, i) => ({
        id: `r${i}`, received_at: 70 - i, text: "y".repeat(30_000),
    }));
    await saveShardSnapshot({ KV: env.KV }, key, many, 1_000 + 300_001);
    const truncated = await loadShardSnapshot(env, key);
    assert.ok(truncated.rows.length > 0 && truncated.rows.length < 40, "必须截行到 ≤512KiB");
    // 单行就超限：放弃写入，旧快照保留（绝不放垃圾进 KV）
    const oneHuge = [{ id: "h", received_at: 70, text: "x".repeat(600_000) }];
    await saveShardSnapshot({ KV: env.KV }, key, oneHuge, 1_000 + 600_001);
    assert.equal((await loadShardSnapshot(env, key)).rows.length, truncated.rows.length, "单行超限必须放弃写入");
    // 无 KV：安静跳过
    await saveShardSnapshot({}, key, rows);
    assert.equal(await loadShardSnapshot({}, key), null);
    // 坏 payload：返回 null 而不是抛错
    store.set(key, "{{{");
    assert.equal(await loadShardSnapshot(env, key), null);
    resetShardSnapshotThrottleForTests();
});
