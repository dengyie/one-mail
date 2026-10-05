import assert from "node:assert/strict";
import test from "node:test";
import { accountsOnShard, groupAccountsByShard, hasRemoteShards, loadShardMap, parseShardMap, resetShardMapCacheForTests, SHARD_MAP_CACHE_MS, SHARD_MAP_KV_KEY, ShardMapError } from "./shard_map.ts";
const valid = { v: 1, shards: [{ id: "shard1", base_url: "https://shard1.example.com/", token: "t".repeat(32) }], accounts: { acctA: "shard1" } };
test("only missing or explicitly empty registry is local", () => {
    assert.deepEqual(parseShardMap(null), { v: 1, shards: [], accounts: {} });
    assert.deepEqual(parseShardMap(JSON.stringify({ v: 1, shards: [], accounts: {} })), { v: 1, shards: [], accounts: {} });
    for (const raw of ["{", "null", JSON.stringify({ ...valid, v: 2 }), JSON.stringify({ ...valid, accounts: { acctA: "missing" } })]) {
        assert.throws(() => parseShardMap(raw), ShardMapError);
    }
    assert.throws(() => parseShardMap("{"), error => error.cause instanceof SyntaxError);
});
test("invalid endpoints fail the entire map without echoing secrets", () => {
    for (const endpoint of [
        { ...valid.shards[0], id: "primary" },
        { ...valid.shards[0], base_url: "http://x.example" },
        { ...valid.shards[0], base_url: "https://x.example/path" },
        { ...valid.shards[0], base_url: "https://user:secret@x.example" },
        { ...valid.shards[0], token: "short" },
    ]) assert.throws(() => parseShardMap(JSON.stringify({ ...valid, shards: [endpoint] })), ShardMapError);
    assert.throws(() => parseShardMap(JSON.stringify({ ...valid, shards: [valid.shards[0], valid.shards[0]] })), ShardMapError);
});
test("validated map normalizes origin and groups real account properties only", () => {
    const parsed = parseShardMap(JSON.stringify(valid));
    assert.equal(parsed.shards[0].base_url, "https://shard1.example.com");
    assert.equal(hasRemoteShards(parsed), true);
    assert.deepEqual(accountsOnShard(parsed, "shard1"), ["acctA"]);
    assert.deepEqual(groupAccountsByShard(parsed, ["acctA", "constructor", "__proto__"]), new Map([["shard1", ["acctA"]]]));
});
test("cache lasts 60s and expired KV failure preserves cause rather than returning local", async () => {
    let now = 1000, reads = 0, failure;
    resetShardMapCacheForTests(() => now);
    const kv = { async get(key) { reads++; assert.equal(key, SHARD_MAP_KV_KEY); if (failure) throw failure; return JSON.stringify(valid); } };
    const first = await loadShardMap({ KV: kv });
    assert.equal(await loadShardMap({ KV: kv }), first);
    assert.equal(reads, 1);
    now += SHARD_MAP_CACHE_MS;
    failure = new Error("KV unavailable");
    await assert.rejects(loadShardMap({ KV: kv }), error => error instanceof ShardMapError && error.cause === failure);
    failure = undefined;
    assert.equal(hasRemoteShards(await loadShardMap({ KV: kv })), true);
    resetShardMapCacheForTests();
});
test("required federation fails closed for missing or pre-cutover registry", async () => {
    resetShardMapCacheForTests();
    await assert.rejects(loadShardMap({ SHARD_FEDERATION_REQUIRED: "1", KV: { get: async () => null } }), /no map/);
    resetShardMapCacheForTests();
    await assert.rejects(loadShardMap({ SHARD_FEDERATION_REQUIRED: "1", SHARD_FEDERATION_MIN_GENERATION: 3, KV: { get: async () => JSON.stringify({ ...valid, generation: 2 }) } }), /generation/);
});
test("cache is isolated by KV binding and missing KV remains local", async () => {
    resetShardMapCacheForTests();
    await loadShardMap({ KV: { get: async () => JSON.stringify(valid) } });
    assert.equal(hasRemoteShards(await loadShardMap({})), false);
    assert.equal(hasRemoteShards(await loadShardMap({ KV: { get: async () => null } })), false);
    resetShardMapCacheForTests();
});
