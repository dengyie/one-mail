import assert from "node:assert/strict";
import test from "node:test";
import { fanOutShards, fetchShardJson, readBearerToken, shardAuthorizationHeader } from "./shard_client.ts";

const shard = {
    id: "shard1",
    base_url: "https://shard1.example.com",
    token: "t".repeat(32),
};

test("readBearerToken requires the Bearer scheme", () => {
    assert.equal(readBearerToken(new Request("https://x", { headers: { authorization: "Bearer abc" } })), "abc");
    assert.equal(readBearerToken(new Request("https://x", { headers: { authorization: "abc" } })), "");
    assert.equal(readBearerToken(new Request("https://x")), "");
    assert.equal(shardAuthorizationHeader("tok"), "Bearer tok");
});

test("fetchShardJson posts JSON, never retries, and maps http/json/network/timeout", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const ok = await fetchShardJson(shard, "/shard/health", { fetchImpl });
    assert.equal(ok.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://shard1.example.com/shard/health");
    assert.equal(calls[0].init.headers.authorization, shardAuthorizationHeader(shard.token));

    const httpFail = await fetchShardJson(shard, "/shard/x", {
        fetchImpl: async () => new Response("nope", { status: 500 }),
    });
    assert.equal(httpFail.ok, false);
    assert.equal(httpFail.error, "http_500");

    const badJson = await fetchShardJson(shard, "/shard/x", {
        fetchImpl: async () => new Response("not-json", { status: 200 }),
    });
    assert.equal(badJson.ok, false);
    assert.equal(badJson.error, "invalid_json:200");

    const network = await fetchShardJson(shard, "/shard/x", {
        fetchImpl: async () => { throw new Error("boom"); },
    });
    assert.equal(network.ok, false);
    assert.equal(network.error, "network");

    const timeout = await fetchShardJson(shard, "/shard/x", {
        timeoutMs: 5,
        fetchImpl: async (_url, init) => {
            await new Promise((_, reject) => {
                init.signal.addEventListener("abort", () => {
                    const err = new Error("aborted");
                    err.name = "AbortError";
                    reject(err);
                });
            });
        },
    });
    assert.equal(timeout.ok, false);
    assert.equal(timeout.error, "timeout");
});

test("fanOutShards returns per-shard results in input order", async () => {
    const shards = [
        { ...shard, id: "a", base_url: "https://a.example.com" },
        { ...shard, id: "b", base_url: "https://b.example.com" },
    ];
    const results = await fanOutShards(shards, "/shard/health", {
        fetchImpl: async (url) => {
            if (url.includes("://a.")) return new Response(JSON.stringify({ id: "a" }), { status: 200 });
            return new Response("fail", { status: 503 });
        },
    });
    assert.equal(results[0].ok, true);
    assert.equal(results[0].data.id, "a");
    assert.equal(results[1].ok, false);
    assert.equal(results[1].error, "http_503");
});

test("deadline covers stalled response body even when fetch ignores abort", async () => {
    let cancelled = false, calls = 0;
    const result = await fetchShardJson(shard, "/shard/x", {
        timeoutMs: 10,
        fetchImpl: async () => {
            calls++;
            return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
        },
    });
    assert.equal(result.error, "timeout");
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
});
test("deadline bounds a fetch implementation that ignores abort", async () => {
    const result = await fetchShardJson(shard, "/shard/x", {
        timeoutMs: 10, fetchImpl: () => new Promise(() => {}),
    });
    assert.equal(result.error, "timeout");
});
test("scope is encoded, redirects forbidden, and network cause retained", async () => {
    const scope = { account_ids: ["邮箱"], sources: ["imap_qq"] };
    const cause = new Error("private network detail");
    const result = await fetchShardJson(shard, "/shard/x", {
        scope, fetchImpl: async (_url, init) => {
            assert.equal(init.redirect, "error");
            assert.deepEqual(JSON.parse(decodeURIComponent(init.headers["x-one-mail-shard-scope"])), scope);
            throw cause;
        },
    });
    assert.equal(result.error, "network");
    assert.equal(result.cause, cause);
    assert.ok(!result.error.includes("private"));
});
test("body read failure retains the stream cause and is not misclassified as network", async () => {
    const cause = new Error("body interrupted");
    const result = await fetchShardJson(shard, "/shard/x", {
        fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.error(cause); } })),
    });
    assert.equal(result.error, "body");
    assert.equal(result.cause, cause);
});
test("empty/null JSON and oversized response are failures", async () => {
    for (const body of ["", "null", "123"]) {
        const result = await fetchShardJson(shard, "/shard/x", { fetchImpl: async () => new Response(body) });
        assert.equal(result.error, "invalid_json:200");
        assert.ok(result.cause instanceof Error);
    }
    const result = await fetchShardJson(shard, "/shard/x", {
        fetchImpl: async () => new Response(new Uint8Array(16 * 1024 * 1024 + 1)),
    });
    assert.equal(result.error, "body_too_large");
});
