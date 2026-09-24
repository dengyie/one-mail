import assert from "node:assert/strict";
import test from "node:test";
import { verifCodes } from "./extra_endpoints.ts";

// 端点级回归：verifCodes 的 addr / domain 双模式与 fail-closed 行为。
// domain 子句经 buildEmailFilters 注入，这里重点锁 SQL 形状与 bind 顺序。

const makeCtx = (query, rows = []) => {
    let captured = null;
    const db = {
        prepare(sql) {
            const stmt = {
                bind(...args) { captured = { sql, binds: args }; return stmt; },
                async all() { return { results: rows }; },
            };
            return stmt;
        },
    };
    const c = {
        req: { query: () => query },
        env: { DB: db },
        // resolveScopedEmailFilter 读 c.get("unifiedUserAuth") / c.get("apiKey")；
        // 这里注入管理员用户通道，使 base 过滤 = buildEmailFilters(q) 原样生效。
        get: (key) => (key === "unifiedUserAuth" ? { isAdmin: true } : undefined),
        json: (body, status) => ({ body, status }),
    };
    return { c, captured: () => captured };
};

const CODE_ROW = {
    subject: "Your verification code is 123456",
    text_body: "Use 123456 to sign in.",
    html_body: "",
    from_addr: "noreply@example.com",
    received_at: Date.now() - 1000,
};

test("verifCodes domain mode suffix-matches whole domain and never pins to_addr", async () => {
    const { c, captured } = makeCtx({ domain: "Mangoqwq.com", fresh: "1440" }, [CODE_ROW]);
    const res = await verifCodes(c);
    assert.deepEqual(res.body.results.map((r) => r.code), ["123456"]);
    const { sql, binds } = captured();
    assert.ok(sql.includes("source = 'cf_routing'"), "domain mode must pin cf_routing");
    assert.ok(sql.includes("to_addr LIKE ?"), "domain mode must suffix-match to_addr");
    assert.ok(!sql.includes("to_addr = ?"), "domain mode must not pin a single to_addr");
    assert.equal(binds[0], "%@mangoqwq.com");
    assert.equal(typeof binds[binds.length - 1], "number", "last bind is the fresh-window since");
});

test("verifCodes addr mode keeps exact to_addr pin", async () => {
    const { c, captured } = makeCtx({ addr: "user@mangoqwq.com" }, [CODE_ROW]);
    const res = await verifCodes(c);
    assert.deepEqual(res.body.results.map((r) => r.code), ["123456"]);
    const { sql, binds } = captured();
    assert.ok(sql.includes("AND to_addr = ?"), "addr mode must pin to_addr");
    assert.equal(binds[0], "user@mangoqwq.com");
});

test("verifCodes rejects requests with neither addr nor domain", async () => {
    const { c, captured } = makeCtx({});
    const res = await verifCodes(c);
    assert.equal(res.status, 400);
    assert.equal(captured(), null, "no DB round-trip without a filter target");
});

test("verifCodes domain wildcard injection fails closed", async () => {
    const { c, captured } = makeCtx({ domain: "%.com", fresh: "1440" });
    const res = await verifCodes(c);
    assert.deepEqual(res.body.results, []);
    assert.ok(captured().sql.includes("1=0"), "invalid domain must compile to 1=0");
});
