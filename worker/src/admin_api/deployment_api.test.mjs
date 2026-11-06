import assert from "node:assert/strict";
import test from "node:test";
import handler from "./deployment_api.ts";

function context(env) {
    return {
        env,
        json: (body, status = 200) => ({ status, body }),
    };
}

test("the endpoint answers 200 with the report", async () => {
    const response = await handler.check(context({
        DB: {
            prepare: () => ({
                all: async () => ({
                    results: ["emails", "scheduled_locks", "audit_logs", "backup_runs"].map((name) => ({ name })),
                }),
            }),
        },
        KV: {},
    }));
    assert.equal(response.status, 200);
    assert.equal(response.body.status, "ready");
    assert.ok(Array.isArray(response.body.checks));
});

test("a broken database still yields a 200 diagnostic, not a 500", async () => {
    const response = await handler.check(context({
        DB: { prepare: () => ({ all: async () => { throw new Error("D1 down"); } }) },
        KV: {},
    }));
    assert.equal(response.status, 200);
    assert.equal(response.body.status, "warning");
});

test("the report never echoes a token", async () => {
    const response = await handler.check(context({
        DB: {
            prepare: () => ({
                all: async () => ({
                    results: ["emails", "scheduled_locks", "audit_logs", "backup_runs"].map((name) => ({ name })),
                }),
            }),
        },
        KV: {},
        BACKUP_BUCKET: {},
        CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
        D1_DATABASE_ID: "5f3e1c0a-9b2d-4e7a-8c61-1d2e3f4a5b6c",
        D1_REST_API_TOKEN: "super-secret-token",
    }));
    assert.ok(!JSON.stringify(response.body).includes("super-secret-token"));
});