import assert from "node:assert/strict";
import test from "node:test";
import {
    AUDIT_ACTOR_ADMIN_KEY,
    AUDIT_ACTOR_ADMIN_TOKEN,
    AUDIT_ACTOR_SYSTEM,
    auditSqlFingerprint,
    isSensitiveAuditKey,
    resolveAuditActor,
    resolveAuditIp,
    sanitizeAuditDetail,
    writeAudit,
} from "./audit_log.ts";

function headerReader(headers) {
    return { req: { header: (name) => headers[name] } };
}

test("redacts sensitive keys at every depth", () => {
    const json = sanitizeAuditDetail({
        password: "hunter2",
        nested: { api_key: "sk-live", access_token: "abc", user_email: "a@b.c" },
        items: [{ secret: "s", label: "keep" }],
    });
    assert.ok(json);
    assert.ok(!json.includes("hunter2"));
    assert.ok(!json.includes("sk-live"));
    assert.ok(!json.includes("\"abc\""));
    assert.ok(json.includes("\"user_email\":\"a@b.c\""));
    assert.ok(json.includes("\"label\":\"keep\""));
    assert.ok(json.includes("[redacted]"));
});

test("does not redact keys that merely contain a sensitive word", () => {
    assert.equal(isSensitiveAuditKey("object_key"), false);
    assert.equal(isSensitiveAuditKey("monkey"), false);
    assert.equal(isSensitiveAuditKey("private_key"), true);
    assert.equal(isSensitiveAuditKey("reset_password"), true);
    assert.equal(isSensitiveAuditKey("verification_code"), true);
});

test("caps long strings, arrays and nested depth", () => {
    const json = sanitizeAuditDetail({
        note: "x".repeat(500),
        list: Array.from({ length: 40 }, (_, index) => index),
        deep: { a: { b: { c: { d: "too deep" } } } },
    });
    assert.ok(json);
    const parsed = JSON.parse(json);
    assert.ok(parsed.note.length <= 201);
    assert.equal(parsed.list.length, 20);
    assert.equal(parsed.deep.a.b, "[truncated]");
});

test("caps the whole detail payload", () => {
    const detail = {};
    for (let index = 0; index < 30; index += 1) {
        detail[`field_${index}`] = "y".repeat(190);
    }
    const json = sanitizeAuditDetail(detail);
    assert.ok(json);
    assert.ok(json.length < 200);
    assert.equal(JSON.parse(json).truncated, true);
});

test("returns null for non-object details", () => {
    assert.equal(sanitizeAuditDetail(null), null);
    assert.equal(sanitizeAuditDetail(undefined), null);
    assert.equal(sanitizeAuditDetail(["a"]), null);
});

test("resolves the credential class, never the secret", () => {
    assert.equal(resolveAuditActor(headerReader({ "x-admin-auth": "secret" })), AUDIT_ACTOR_ADMIN_KEY);
    assert.equal(resolveAuditActor(headerReader({ "x-user-access-token": "jwt" })), AUDIT_ACTOR_ADMIN_TOKEN);
    assert.equal(resolveAuditActor(headerReader({})), AUDIT_ACTOR_SYSTEM);
});

test("resolves and truncates the client ip", () => {
    assert.equal(resolveAuditIp(headerReader({ "cf-connecting-ip": "203.0.113.7" })), "203.0.113.7");
    assert.equal(
        resolveAuditIp(headerReader({ "x-forwarded-for": "198.51.100.9, 10.0.0.1" })),
        "198.51.100.9",
    );
    assert.equal(resolveAuditIp(headerReader({ "cf-connecting-ip": "z".repeat(90) })).length, 64);
    assert.equal(resolveAuditIp(headerReader({})), null);
});

test("sql fingerprint is stable, short and does not expose the statement", async () => {
    const sql = "DELETE FROM emails WHERE created_at < '2026-01-01'";
    const first = await auditSqlFingerprint(sql);
    const second = await auditSqlFingerprint(sql);
    assert.equal(first, second);
    assert.match(first, /^[0-9a-f]{16}$/);
    assert.notEqual(first, await auditSqlFingerprint(`${sql} AND id > 0`));
    assert.ok(!first.includes("DELETE"));
});

test("writeAudit binds the sanitized row", async () => {
    const calls = [];
    const env = {
        DB: {
            prepare: (sql) => ({
                bind: (...args) => {
                    calls.push({ sql, args });
                    return { run: async () => ({ success: true }) };
                },
            }),
        },
    };
    await writeAudit(env, {
        actor: AUDIT_ACTOR_ADMIN_KEY,
        action: "user.delete",
        targetType: "user",
        targetId: "42",
        detail: { password: "hunter2", address_count: 3 },
        ip: "203.0.113.7",
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /INSERT INTO audit_logs/);
    assert.deepEqual(calls[0].args.slice(0, 4), [AUDIT_ACTOR_ADMIN_KEY, "user.delete", "user", "42"]);
    assert.ok(!calls[0].args[4].includes("hunter2"));
    assert.ok(calls[0].args[4].includes("\"address_count\":3"));
    assert.equal(calls[0].args[5], "203.0.113.7");
});

test("writeAudit never rejects when the table or database is unavailable", async () => {
    const env = {
        DB: {
            prepare: () => {
                throw new Error("no such table: audit_logs");
            },
        },
    };
    await assert.doesNotReject(() =>
        writeAudit(env, { actor: AUDIT_ACTOR_SYSTEM, action: "test", targetType: "test" }),
    );

    const failingRun = {
        DB: {
            prepare: () => ({
                bind: () => ({ run: async () => { throw new Error("D1 down"); } }),
            }),
        },
    };
    await assert.doesNotReject(() =>
        writeAudit(failingRun, { actor: AUDIT_ACTOR_SYSTEM, action: "test", targetType: "test" }),
    );
});
