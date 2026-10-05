import assert from "node:assert/strict";
import test from "node:test";
import { authorizeShardRequest, shardTokenConfigured, parseShardScope, shardScopeAllowsRow } from "./shard_auth.ts";

const TOKEN = "s".repeat(32);

test("shardTokenConfigured requires at least 32 bytes", () => {
    assert.equal(shardTokenConfigured(undefined), false);
    assert.equal(shardTokenConfigured("short"), false);
    assert.equal(shardTokenConfigured(TOKEN), true);
});

test("authorizeShardRequest rejects missing config, missing bearer, and mismatches", async () => {
    const req = (auth) => new Request("https://shard.example/shard/health", {
        headers: auth ? { authorization: auth } : {},
    });
    assert.equal(await authorizeShardRequest({}, req(`Bearer ${TOKEN}`)), false);
    assert.equal(await authorizeShardRequest({ SHARD_TOKEN: TOKEN }, req("")), false);
    assert.equal(await authorizeShardRequest({ SHARD_TOKEN: TOKEN }, req(`Bearer ${"x".repeat(32)}`)), false);
    assert.equal(await authorizeShardRequest({ SHARD_TOKEN: TOKEN }, req(`Bearer ${TOKEN}`)), true);
    assert.equal(await authorizeShardRequest({ SHARD_TOKEN: TOKEN }, req(TOKEN)), false);
    assert.equal(shardTokenConfigured(" ".repeat(32)), false);
});
test("scope must be explicit and row permissions intersect account and source", () => {
    const request = value => new Request("https://shard.example", { headers: { "x-one-mail-shard-scope": encodeURIComponent(JSON.stringify(value)) } });
    for (const value of [{}, { account_ids: "a", sources: null }, { account_ids: null, sources: [1] }]) {
        assert.equal(parseShardScope(request(value)), null);
    }
    const scope = parseShardScope(request({ account_ids: ["a"], sources: ["imap_qq"] }));
    assert.equal(shardScopeAllowsRow(scope, { account_id: "a", source: "imap_qq" }), true);
    assert.equal(shardScopeAllowsRow(scope, { account_id: "b", source: "imap_qq" }), false);
    assert.equal(shardScopeAllowsRow(scope, { account_id: "a", source: "graph_outlook" }), false);
    assert.equal(shardScopeAllowsRow({ account_ids: [], sources: null }, { account_id: "a" }), false);
    assert.equal(shardScopeAllowsRow({ account_ids: null, sources: null }, {}), true);
});
