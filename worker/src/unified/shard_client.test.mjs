import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers";
import { fanOutShards, fetchShardJson, readBearerToken, shardAuthorizationHeader } from "./shard_client.ts";
import * as client from "./shard_client.ts";

const shard = {
    id: "shard1",
    base_url: "https://shard1.example.com",
    token: "t".repeat(32),
};
const twelveShards = Array.from({ length: 12 }, (_, index) => ({
    ...shard, id: `shard${index}`, base_url: `https://shard${index}.example.com`,
}));
const turn = () => new Promise((resolve) => setImmediate(resolve));

test("redirect responses are never accepted and their bodies are cancelled", async () => {
    let cancelled = false;
    const result = await fetchShardJson(shard, "/shard/health", {
        acceptedStatuses: [302],
        fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
            status: 302, headers: { location: "https://wrong.example" },
        }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "http_302");
    await result.diagnostics.cleanup;
    assert.equal(cancelled, true);
});

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
            assert.equal(init.redirect, "manual");
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

test("12-shard fanout bounds active requests to four and retains input order", async () => {
    const pending = [];
    let active = 0, peak = 0;
    const task = fanOutShards(twelveShards, "/shard/health", {
        fetchImpl: async (url) => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((resolve) => pending.push(resolve));
            active--;
            return Response.json({ url });
        },
    });
    await turn();
    const firstWave = pending.length;
    while (pending.length) {
        pending.splice(0).reverse().forEach((resolve) => resolve());
        await turn();
    }
    const result = await task;
    assert.equal(firstWave, 4);
    assert.equal(peak, 4);
    assert.deepEqual(result.map((item) => item.shard_id), twelveShards.map((item) => item.id));
    assert.ok(result.every((item) => item.ok));
});

test("fanout queues consume one shared deadline instead of restarting per wave", async (t) => {
    let now = 0;
    t.mock.method(performance, "now", () => now);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let calls = 0;
    const signals = [];
    const task = fanOutShards(twelveShards, "/shard/health", {
        timeoutMs: 60,
        fetchImpl: async (_url, init) => {
            calls++;
            signals.push(init.signal);
            await new Promise((resolve) => setTimeout(resolve, 40));
            return Response.json({ ok: true });
        },
    });
    now = 40;
    t.mock.timers.tick(40);
    await turn();
    now = 60;
    t.mock.timers.tick(20);
    const results = await task;
    assert.equal(calls, 8);
    assert.deepEqual(results.map((item) => item.ok ? "ok" : item.error), [
        ...Array(4).fill("ok"), ...Array(8).fill("timeout"),
    ]);
    assert.ok(signals.slice(4).every((signal) => signal.aborted));
});

test("caller cancellation aborts in-flight requests and never starts queued shards", async () => {
    const controller = new AbortController();
    const cause = new Error("caller disconnected");
    const signals = [];
    const task = fanOutShards(twelveShards, "/shard/health", {
        signal: controller.signal, timeoutMs: 50,
        fetchImpl: async (_url, init) => {
            signals.push(init.signal);
            return new Promise(() => {});
        },
    });
    await turn();
    controller.abort(cause);
    const result = await task;
    assert.equal(signals.length, 4);
    assert.ok(signals.every((signal) => signal.aborted));
    assert.ok(result.every((item) => item.error === "cancelled" && item.cause === cause));
});

test("already cancelled or expired requests do not fetch", async () => {
    const controller = new AbortController();
    controller.abort("disconnect");
    let calls = 0;
    const fetchImpl = async () => { calls++; return Response.json({}); };
    const cancelled = await fetchShardJson(shard, "/shard/x", { signal: controller.signal, fetchImpl });
    const expired = await fetchShardJson(shard, "/shard/x", { deadlineAtMs: performance.now() - 1, fetchImpl });
    assert.equal(cancelled.error, "cancelled");
    assert.equal(expired.error, "timeout");
    assert.equal(calls, 0);
});

test("per-response limits count streamed bytes and cancel oversized bodies", async () => {
    let cancelled = 0;
    const result = await fetchShardJson(shard, "/shard/emails", {
        maxBodyBytes: 16,
        fetchImpl: async () => new Response(new ReadableStream({
            start(controller) { controller.enqueue(new TextEncoder().encode('{"payload":"123456789"}')); },
            cancel() { cancelled++; },
        })),
    });
    assert.equal(result.error, "body_too_large");
    assert.equal(cancelled, 1);
});

test("one request budget includes completed results across all fanout waves", async () => {
    const budget = client.createShardResponseBudget(100);
    const body = JSON.stringify({ payload: "x".repeat(36) }); // 50 UTF-8 bytes.
    assert.equal(new TextEncoder().encode(body).byteLength, 50);
    const result = await fanOutShards(twelveShards, "/shard/emails", {
        responseBudget: budget,
        maxBodyBytes: 100,
        fetchImpl: async () => new Response(body),
    });
    assert.equal(result.filter((item) => item.ok).length, 2);
    assert.equal(result.filter((item) => item.error === "response_budget_exceeded").length, 10);
    assert.equal(budget.usedBytes, 100);
});

test("per-shard fanout requests preserve independent body, scope, and credentials", async () => {
    const requests = twelveShards.map((target, index) => ({
        shard: { ...target, token: `token${index}` }, path: `/shard/${index}`,
        init: { body: { index }, scope: { account_ids: [String(index)], sources: null } },
    }));
    const result = await client.fanOutShardRequests(requests, {
        fetchImpl: async (url, init) => {
            const index = Number(new URL(url).pathname.split("/").at(-1));
            assert.equal(init.headers.authorization, `Bearer token${index}`);
            assert.deepEqual(JSON.parse(init.body), { index });
            assert.deepEqual(JSON.parse(decodeURIComponent(init.headers["x-one-mail-shard-scope"])), {
                account_ids: [String(index)], sources: null,
            });
            return Response.json({ index });
        },
    });
    assert.deepEqual(result.map((item) => item.data.index), Array.from({ length: 12 }, (_, index) => index));
});

test("list and detail byte limits apply to decoded body bytes regardless of content-length", async () => {
    assert.equal(client.SHARD_LIST_MAX_BYTES, 512 * 1024);
    assert.equal(client.SHARD_DETAIL_MAX_BYTES, 8 * 1024 * 1024);
    const body = JSON.stringify({ payload: "x".repeat(client.SHARD_LIST_MAX_BYTES - 14) });
    const fetchImpl = async () => new Response(body, { headers: { "content-length": "1" } });
    const exact = await fetchShardJson(shard, "/shard/emails", { maxBodyBytes: client.SHARD_LIST_MAX_BYTES, fetchImpl });
    assert.equal(exact.ok, true);
    const tooLarge = await fetchShardJson(shard, "/shard/emails", {
        maxBodyBytes: client.SHARD_LIST_MAX_BYTES - 1, fetchImpl,
    });
    assert.equal(tooLarge.error, "body_too_large");
    const detail = await fetchShardJson(shard, "/shard/emails/123", { maxBodyBytes: client.SHARD_DETAIL_MAX_BYTES, fetchImpl });
    assert.equal(detail.ok, true);
    const oversizedDetail = await fetchShardJson(shard, "/shard/emails/123", {
        maxBodyBytes: client.SHARD_DETAIL_MAX_BYTES,
        fetchImpl: async () => new Response(new Uint8Array(client.SHARD_DETAIL_MAX_BYTES + 1)),
    });
    assert.equal(oversizedDetail.error, "body_too_large");
});

test("fanout defaults to an 8MiB cumulative budget across twelve responses", async () => {
    const body = JSON.stringify({ payload: "x".repeat(800 * 1024 - 14) });
    const results = await fanOutShards(twelveShards, "/shard/emails", {
        fetchImpl: async () => new Response(body),
    });
    assert.equal(results.filter((item) => item.ok).length, 10);
    assert.equal(results.filter((item) => item.error === "response_budget_exceeded").length, 2);
});

test("streaming decode preserves multibyte characters split across chunks and releases the reader", async () => {
    const value = { message: "邮箱 📬" };
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const body = new ReadableStream({
        start(controller) {
            for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.subarray(i, i + 1));
            controller.close();
        },
    });
    const budget = client.createShardResponseBudget(bytes.length);
    const result = await fetchShardJson(shard, "/shard/x", {
        responseBudget: budget, fetchImpl: async () => new Response(body),
    });
    assert.deepEqual(result.data, value);
    assert.equal(budget.usedBytes, bytes.length);
    assert.equal(body.locked, false);
});

test("body cancellation retains cleanup failures and releases its reader lock", async () => {
    const controller = new AbortController();
    const cause = new Error("caller left");
    const cancellationCause = new Error("stream cancel failed");
    const body = new ReadableStream({ cancel() { throw cancellationCause; } });
    const task = fetchShardJson(shard, "/shard/x", {
        signal: controller.signal,
        fetchImpl: async () => new Response(body),
    });
    await turn();
    controller.abort(cause);
    const result = await task;
    await result.diagnostics.cleanup;
    assert.equal(result.error, "cancelled");
    assert.equal(result.cause, cause);
    assert.ok(result.diagnostics.cancellationCauses.includes(cancellationCause));
    assert.equal(body.locked, false);
});

test("late response from a fetch that ignores timeout is cancelled without reading", async () => {
    let resolveFetch;
    let cancelled = 0;
    const body = new ReadableStream({ cancel() { cancelled++; } });
    const result = await fetchShardJson(shard, "/shard/x", {
        timeoutMs: 5, fetchImpl: () => new Promise((resolve) => { resolveFetch = resolve; }),
    });
    assert.equal(result.error, "timeout");
    resolveFetch(new Response(body));
    await turn();
    await result.diagnostics.cleanup;
    assert.equal(cancelled, 1);
    assert.equal(body.locked, false);
});

test("stalled stream cancellation does not extend the response deadline", async () => {
    const body = new ReadableStream({ cancel() { return new Promise(() => {}); } });
    const result = await fetchShardJson(shard, "/shard/x", {
        timeoutMs: 5, fetchImpl: async () => new Response(body),
    });
    assert.equal(result.error, "timeout");
    await turn();
    assert.equal(body.locked, false);
});
