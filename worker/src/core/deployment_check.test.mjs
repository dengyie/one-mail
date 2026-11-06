import assert from "node:assert/strict";
import test from "node:test";
import { collectDeploymentChecks } from "./deployment_check.ts";

function dbWith(tables, { fail = false } = {}) {
    return {
        prepare: () => ({
            all: async () => {
                if (fail) throw new Error("D1 down");
                return { results: tables.map((name) => ({ name })) };
            },
        }),
    };
}

function summary(report) {
    return Object.fromEntries(report.checks.map((check) => [check.name, check.state]));
}

test("healthy deployment reports ready with a manual aggregator note", async () => {
    const report = await collectDeploymentChecks({
        DB: dbWith(["emails", "scheduled_locks", "audit_logs", "backup_runs"]),
        KV: {},
    });
    assert.equal(report.status, "ready");
    assert.equal(summary(report).aggregator, "manual");
});

test("missing core bindings and tables are reported as missing", async () => {
    const report = await collectDeploymentChecks({
        DB: dbWith([]),
    });
    assert.equal(report.status, "missing");
    const states = summary(report);
    assert.equal(states.d1, "ready");
    assert.equal(states.kv, "missing");
    assert.equal(states.tables, "missing");
});

test("no DB binding is missing, not a crash", async () => {
    const report = await collectDeploymentChecks({});
    const states = summary(report);
    assert.equal(states.d1, "missing");
    assert.equal(states.tables, "warning");
    assert.equal(report.status, "missing");
});

test("absent feature tables degrade to warning without naming features as down", async () => {
    const report = await collectDeploymentChecks({
        DB: dbWith(["emails", "scheduled_locks"]),
        KV: {},
    });
    assert.equal(report.status, "warning");
    assert.equal(summary(report).feature_tables, "warning");
    assert.equal(summary(report).tables, "ready");
});

test("a failing schema query is a warning, never a throw", async () => {
    const report = await collectDeploymentChecks({ DB: dbWith([], { fail: true }), KV: {} });
    assert.equal(summary(report).tables, "warning");
});

test("backup is manual when unconfigured and warns on a bad target", async () => {
    const disabled = await collectDeploymentChecks({ DB: dbWith(["emails", "scheduled_locks"]), KV: {} });
    assert.equal(summary(disabled).backup, "manual");

    const badTarget = await collectDeploymentChecks({
        DB: dbWith(["emails", "scheduled_locks", "audit_logs", "backup_runs"]),
        KV: {},
        BACKUP_BUCKET: {},
        CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
        D1_DATABASE_ID: "one-mail-db",
        D1_REST_API_TOKEN: "token",
    });
    assert.equal(summary(badTarget).backup, "warning");
    assert.equal(badTarget.status, "warning");
});

test("report never contains a token value", async () => {
    const report = await collectDeploymentChecks({
        DB: dbWith(["emails", "scheduled_locks", "audit_logs", "backup_runs"]),
        KV: {},
        BACKUP_BUCKET: {},
        CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
        D1_DATABASE_ID: "5f3e1c0a-9b2d-4e7a-8c61-1d2e3f4a5b6c",
        D1_REST_API_TOKEN: "super-secret-token",
    });
    assert.ok(!JSON.stringify(report).includes("super-secret-token"));
});