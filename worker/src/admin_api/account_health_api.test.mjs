import assert from "node:assert/strict";
import test from "node:test";
import { list, upsert as upsertHandler } from "./account_health_api.ts";

const handler = { upsert: upsertHandler, list };

function context(env, body) {
    return {
        env,
        req: { json: async () => body },
        json: (data, status = 200) => ({ status, data }),
    };
}

/** Minimal D1 stub: records bound statements, answers per-query fixtures. */
function d1Stub({ healthRows = [], heartbeatRows = [], failPrepare = null } = {}) {
    const statements = [];
    return {
        statements,
        prepare(sql) {
            if (failPrepare) throw failPrepare;
            return {
                bind: (...args) => {
                    statements.push({ sql, args });
                    return {
                        run: async () => ({ success: true }),
                    };
                },
                all: async () => {
                    if (sql.includes("aggregator_account_health")) return { results: healthRows };
                    if (sql.includes("aggregator_daemon_heartbeat")) return { results: heartbeatRows };
                    return { results: [] };
                },
            };
        },
        batch: async (stmts) => ({ length: stmts.length }),
    };
}

// ------------------------------------------------------------- upsert

test("upsert writes daemon heartbeat and account rows via batch", async () => {
    const db = d1Stub();
    const response = await handler.upsert(context({ DB: db }, {
        daemon: { started_at: 1700000000000, accounts_count: 2, socks5_egress: "127.0.0.1:7897", aggregator_version: "0.1.0" },
        accounts: [
            { account_id: "qq-main", source: "qq", username: "u@x", user_managed: false, fail_count: 0, skip_until: 0, idle_alive: true },
            { account_id: "uma-1", label: "uma-1", user_managed: true, last_error: "AUTHENTICATIONFAILED", error_kind: "auth", fail_count: 2 },
        ],
    }));
    assert.equal(response.status, 200);
    assert.equal(response.data.success, true);
    assert.equal(response.data.accounts, 2);
    // 1 heartbeat statement + 2 account statements (batched)
    assert.equal(db.statements.length, 3);
    const heartbeat = db.statements.find((s) => s.sql.includes("aggregator_daemon_heartbeat"));
    assert.ok(heartbeat);
    // id=1 是 SQL 字面量；args = [started_at, accounts_count, socks5_egress, aggregator_version, updated_at]
    assert.deepEqual(heartbeat.args.slice(1, 4), [2, "127.0.0.1:7897", "0.1.0"]);
    const accountRow = db.statements.find((s) => s.sql.includes("aggregator_account_health"));
    assert.ok(accountRow);
    // idle_alive boolean coerced to 1, user_managed false to 0
    assert.equal(accountRow.args[4], 0);
    assert.equal(accountRow.args[10], 1);
});

test("upsert sanitizes unknown error_kind and overlong errors", async () => {
    const db = d1Stub();
    const response = await handler.upsert(context({ DB: db }, {
        accounts: [{ account_id: "a1", last_error: "x".repeat(900), error_kind: "weird-kind" }],
    }));
    assert.equal(response.status, 200);
    const row = db.statements[0];
    assert.equal(row.args[6].length, 500);
    assert.equal(row.args[7], "unknown");
});

test("upsert drops malformed rows without failing the request", async () => {
    const db = d1Stub();
    const response = await handler.upsert(context({ DB: db }, {
        accounts: [null, "garbage", { account_id: "  " }, { account_id: "ok-1" }],
    }));
    assert.equal(response.status, 200);
    assert.equal(response.data.accounts, 1);
    assert.equal(db.statements.length, 1);
});

test("upsert with empty payload still refreshes heartbeat only", async () => {
    const db = d1Stub();
    const response = await handler.upsert(context({ DB: db }, { daemon: { accounts_count: 0 } }));
    assert.equal(response.status, 200);
    assert.equal(db.statements.length, 1);
    assert.ok(db.statements[0].sql.includes("aggregator_daemon_heartbeat"));
});

test("upsert DB failure answers 500, not a silent success", async () => {
    const db = d1Stub({ failPrepare: new Error("D1 quota exceeded") });
    const response = await handler.upsert(context({ DB: db }, { accounts: [{ account_id: "a" }] }));
    assert.equal(response.status, 500);
    assert.equal(response.data.success, false);
});

// ------------------------------------------------------------- list

test("list returns accounts with derived freshness fields", async () => {
    const now = Date.now();
    const db = d1Stub({
        healthRows: [
            { account_id: "qq-main", last_error: null, error_kind: null, skip_until: 0, updated_at: now - 60000 },
            { account_id: "uma-1", last_error: "boom", error_kind: "auth", skip_until: now + 300000, updated_at: now - 60000 },
        ],
        heartbeatRows: [{ updated_at: now - 120000, accounts_count: 2, socks5_egress: "127.0.0.1:7897" }],
    });
    const response = await handler.list(context({ DB: db }));
    assert.equal(response.status, 200);
    assert.equal(response.data.accounts.length, 2);
    const [qq, uma] = response.data.accounts;
    assert.equal(qq.fresh, true);
    assert.equal(qq.breaker_open, false);
    assert.equal(uma.breaker_open, true);
    assert.equal(response.data.daemon.stale, false);
    assert.ok(response.data.daemon.age_ms >= 120000);
});

test("list marks stale daemon after 30 minutes without heartbeat", async () => {
    const now = Date.now();
    const db = d1Stub({
        healthRows: [{ account_id: "qq-main", updated_at: now - 40 * 60 * 1000 }],
        heartbeatRows: [{ updated_at: now - 40 * 60 * 1000 }],
    });
    const response = await handler.list(context({ DB: db }));
    assert.equal(response.data.daemon.stale, true);
    assert.equal(response.data.accounts[0].fresh, false);
});

test("list with no data at all returns empty report, not an error", async () => {
    const db = d1Stub();
    const response = await handler.list(context({ DB: db }));
    assert.equal(response.status, 200);
    assert.deepEqual(response.data.accounts, []);
    assert.equal(response.data.daemon, null);
});

test("list DB failure still answers 200 with a warning field", async () => {
    const db = d1Stub({ failPrepare: new Error("D1 down") });
    const response = await handler.list(context({ DB: db }));
    assert.equal(response.status, 200);
    assert.equal(response.data.warning, "health query failed; see Worker logs");
    assert.deepEqual(response.data.accounts, []);
});

// ------------------------------------------------------- deployment_check

test("deployment_check reads heartbeat: fresh heartbeat is ready, stale is warning", async () => {
    const { collectDeploymentChecks } = await import("../core/deployment_check.ts");
    const now = Date.now();

    const fresh = await collectDeploymentChecks({
        DB: {
            prepare: (sql) => ({
                all: async () => {
                    if (sql.includes("sqlite_master")) {
                        return { results: ["emails", "scheduled_locks", "audit_logs", "backup_runs"].map((name) => ({ name })) };
                    }
                    if (sql.includes("aggregator_daemon_heartbeat")) {
                        return { results: [{ updated_at: now - 120000, accounts_count: 6 }] };
                    }
                    return { results: [] };
                },
            }),
        },
        KV: {},
    });
    const aggregatorFresh = fresh.checks.find((check) => check.name === "aggregator");
    assert.equal(aggregatorFresh.state, "ready");
    assert.ok(aggregatorFresh.detail.includes("6 accounts"));

    const stale = await collectDeploymentChecks({
        DB: {
            prepare: (sql) => ({
                all: async () => {
                    if (sql.includes("sqlite_master")) {
                        return { results: ["emails", "scheduled_locks", "audit_logs", "backup_runs"].map((name) => ({ name })) };
                    }
                    if (sql.includes("aggregator_daemon_heartbeat")) {
                        return { results: [{ updated_at: now - 45 * 60 * 1000, accounts_count: 6 }] };
                    }
                    return { results: [] };
                },
            }),
        },
        KV: {},
    });
    const aggregatorStale = stale.checks.find((check) => check.name === "aggregator");
    assert.equal(aggregatorStale.state, "warning");
    assert.equal(stale.status, "warning");

    const noHeartbeat = await collectDeploymentChecks({
        DB: {
            prepare: (sql) => ({
                all: async () => {
                    if (sql.includes("sqlite_master")) {
                        return { results: ["emails", "scheduled_locks", "audit_logs", "backup_runs"].map((name) => ({ name })) };
                    }
                    return { results: [] };
                },
            }),
        },
        KV: {},
    });
    const aggregatorNone = noHeartbeat.checks.find((check) => check.name === "aggregator");
    assert.equal(aggregatorNone.state, "manual");
});
