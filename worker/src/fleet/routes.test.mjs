import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers";
import api from "./routes.ts";
import { deployedFleetMode } from "./mode.ts";

const READ = "read-" + "r".repeat(32);
const CONTROL = "control-" + "c".repeat(32);
const snapshot = () => ({ v: 2, revision: "9007199254740993", published_at: "2026-10-08T12:00:00Z", mailbox_routes: {}, shards: {} });
const fixture = (handler = () => Response.json(snapshot()), overrides = {}) => {
    const calls = [];
    const env = {
        FLEET_MODE: "observe", FLEET_READ_TOKEN: READ, FLEET_CONTROL_TOKEN: CONTROL,
        FLEET_REGISTRY: {
            idFromName: name => { assert.equal(name, "one-mail:fleet-registry:v2"); return name; },
            get: () => ({ fetch: async (url, init) => { calls.push({ url, init }); return handler(url, init); } }),
        },
        ...overrides,
    };
    const request = (path = "/snapshot", { token = READ, method = "GET", body, headers = {}, signal } = {}) => api.fetch(new Request(`https://main.example/internal/fleet${path}`, {
        method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), signal,
    }), env);
    return { request, calls, env };
};

test("mode defaults to static and rejects unsupported dynamic or misspelled configuration", () => {
    assert.equal(deployedFleetMode({}), "legacy-static");
    assert.equal(deployedFleetMode({ FLEET_MODE: "observe" }), "observe");
    for (const mode of ["allocate", "rebalance", "Observe", "unknown"]) assert.throws(() => deployedFleetMode({ FLEET_MODE: mode }), /MODE_DISABLED/);
});

test("service identity is separate, read-only identity cannot configure or submit telemetry", async () => {
    const f = fixture();
    for (const token of ["", "ingest-" + "i".repeat(32), "wrong-" + "x".repeat(32)]) {
        assert.equal((await f.request("/snapshot", { token, headers: { "x-admin-auth": CONTROL, "x-user-token": CONTROL } })).status, 401);
    }
    for (const path of ["/metrics", "/configure"]) assert.equal((await f.request(path, { method: "POST", body: {} })).status, 403);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.request()).status, 200);
    assert.equal((await f.request("/snapshot", { token: CONTROL })).status, 200);
});

test("missing/equal service secrets fail closed without registry access", async () => {
    for (const overrides of [{ FLEET_READ_TOKEN: undefined }, { FLEET_CONTROL_TOKEN: "short" }, { FLEET_CONTROL_TOKEN: READ }]) {
        const f = fixture(undefined, overrides);
        assert.equal((await f.request()).status, 503);
        assert.equal(f.calls.length, 0);
    }
});

test("legacy service stays disabled, and unfinished ownership APIs cannot be reached", async () => {
    const legacy = fixture(undefined, { FLEET_MODE: "legacy-static" });
    assert.equal((await legacy.request()).status, 404);
    const dynamic = fixture(undefined, { FLEET_MODE: "allocate" });
    assert.equal((await dynamic.request()).status, 503);
    const f = fixture();
    for (const path of ["/allocate", "/import", "/confirm", "/tombstone", "/migrations"]) {
        assert.equal((await f.request(path, { token: CONTROL, method: "POST", body: { gate_confirmed: true, known_empty: true } })).status, 404);
    }
    assert.equal(f.calls.length, 0);
});

test("snapshot validates public contract, preserves uint64 ETag, and authenticates conditional requests", async () => {
    const f = fixture();
    const response = await f.request();
    assert.deepEqual(await response.json(), snapshot());
    assert.equal(response.headers.get("etag"), '"fleet-9007199254740993"');
    assert.equal(response.headers.get("vary"), "Authorization");
    const headers = { "if-none-match": response.headers.get("etag") };
    const cached = await f.request("/snapshot", { headers });
    assert.equal(cached.status, 304);
    assert.equal(await cached.text(), "");
    assert.equal((await f.request("/snapshot", { headers, token: "bad" })).status, 401);
    const invalid = fixture(() => Response.json({ ...snapshot(), credential_ref: "private-secret" }));
    const rejected = await invalid.request();
    assert.equal(rejected.status, 503);
    assert.ok(!(await rejected.text()).includes("private-secret"));
});

test("body limits, invalid telemetry and aborted requests fail before persistent writes", async () => {
    const f = fixture();
    for (const body of ["{", [], { expected_revision: 1, idempotency_key: "bad", report: {} }]) {
        assert.equal((await f.request("/metrics", { token: CONTROL, method: "POST", body })).status, 400);
    }
    assert.equal((await f.request("/configure", { token: CONTROL, method: "POST", body: "x".repeat(256 * 1024 + 1) })).status, 413);
    const abort = new AbortController(); abort.abort(new Error("request cancelled"));
    assert.equal((await f.request("/snapshot", { signal: abort.signal })).status, 503);
    assert.equal(f.calls.length, 0);
});

test("control requests retain stable idempotency body and plan never uses a write endpoint", async () => {
    const f = fixture(url => Response.json(url.endsWith("/plan")
        ? { ok: true, revision: "6", decision: { ok: false, error_code: "STALE_METRICS" } }
        : { ok: true, revision: "6", consecutive_valid_samples: 1 }));
    const body = { expected_revision: "5", idempotency_key: "sample-001", report: {
        snapshot: { account_key: "main", utc_date: "2026-10-08", observed_at: "2026-10-08T12:00:00Z", source: "cloudflare_graphql", rows_read: 10, rows_written: 2, worker_requests: 3, confidence: "authoritative", shard_sizes: { primary: 20 } },
        projected_rows_read: 20, projected_rows_written: 4, projected_worker_requests: 6,
    } };
    assert.equal((await f.request("/metrics", { method: "POST", token: CONTROL, body })).status, 200);
    assert.deepEqual(JSON.parse(f.calls[0].init.body), body);
    assert.equal(f.calls[0].url, "https://fleet-registry.internal/metrics");
    assert.equal((await f.request("/plan", { method: "POST", body: { expected_revision: "6" } })).status, 200);
    assert.equal(f.calls[1].url, "https://fleet-registry.internal/plan");
});

test("registry failure has stable error, retry hint and no infrastructure response leakage", async () => {
    const f = fixture(() => { throw new Error("credential or SQL must stay private"); });
    const response = await f.request();
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "5");
    const body = await response.json();
    assert.equal(body.error_code, "REGISTRY_UNAVAILABLE");
    assert.equal(body.retryable, true);
    assert.match(body.request_id, /^[a-z0-9-]{36}$/);
    assert.ok(!JSON.stringify(body).includes("credential or SQL"));
});

test("outer deadline covers a client upload stream that never completes", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture();
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const pending = api.fetch(new Request("https://main.example/internal/fleet/plan", { method: "POST", headers: { authorization: `Bearer ${READ}` }, body, duplex: "half" }), f.env);
    // Allow asynchronous authentication to finish before advancing the deadline.
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(5_001);
    const response = await pending;
    assert.equal(response.status, 503);
    assert.equal(f.calls.length, 0);
    assert.equal(cancelled, true);
});
