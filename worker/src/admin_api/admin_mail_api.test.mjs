import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";

registerHooks({
    resolve(specifier, context, next) {
        try { return next(specifier, context); }
        catch (cause) {
            if (!specifier.startsWith(".")) throw cause;
            for (const suffix of [".ts", "/index.ts"]) {
                const target = new URL(specifier + suffix, context.parentURL);
                if (existsSync(target)) return next(target.href, context);
            }
            throw cause;
        }
    },
});

const { default: admin_mail_api } = await import("./admin_mail_api.ts");

const makeCtx = (query = {}) => {
    let capturedListSql = null;
    let capturedBinds = null;

    const fullQuery = { limit: "20", offset: "0", ...query };

    const db = {
        prepare(sql) {
            capturedListSql = sql;
            const stmt = {
                bind(...args) {
                    capturedBinds = args;
                    return stmt;
                },
                async all() {
                    return { results: [] };
                },
                async first() {
                    return { count: 0 };
                },
            };
            return stmt;
        },
    };

    const c = {
        req: {
            query: (key) => (key ? fullQuery[key] : fullQuery),
            param: (key) => ({}),
        },
        env: { DB: db },
        json: (body, status) => ({ body, status }),
        text: (body, status) => ({ body, status }),
    };

    return {
        c,
        getSql: () => capturedListSql,
        getBinds: () => capturedBinds,
    };
};

test("admin_mail_api getMails supports domain parameter with SQL LIKE escaping", async () => {
    const { c, getSql, getBinds } = makeCtx({ domain: "dengyie.tech" });
    await admin_mail_api.getMails(c);
    assert.ok(getSql().includes("address LIKE ? ESCAPE '\\'"));
    assert.equal(getBinds()[0], "%@dengyie.tech");
});

test("admin_mail_api getMails strips leading @ from domain parameter", async () => {
    const { c, getBinds } = makeCtx({ domain: "@mangoqwq.tech" });
    await admin_mail_api.getMails(c);
    assert.equal(getBinds()[0], "%@mangoqwq.tech");
});

test("admin_mail_api getMails handles address patterns: @domain and wildcard *", async () => {
    // 1. @dengyie.tech
    const { c: c1, getSql: getSql1, getBinds: getBinds1 } = makeCtx({ address: "@dengyie.tech" });
    await admin_mail_api.getMails(c1);
    assert.ok(getSql1().includes("address LIKE ? ESCAPE '\\'"));
    assert.equal(getBinds1()[0], "%@dengyie.tech");

    // 2. user_*@dengyie.tech
    const { c: c2, getSql: getSql2, getBinds: getBinds2 } = makeCtx({ address: "user_*@dengyie.tech" });
    await admin_mail_api.getMails(c2);
    assert.ok(getSql2().includes("address LIKE ? ESCAPE '\\'"));
    assert.equal(getBinds2()[0], "user\\_%@dengyie.tech");

    // 3. Exact address match admin@dengyie.tech
    const { c: c3, getSql: getSql3, getBinds: getBinds3 } = makeCtx({ address: "admin@dengyie.tech" });
    await admin_mail_api.getMails(c3);
    assert.ok(getSql3().includes("address = ?"));
    assert.equal(getBinds3()[0], "admin@dengyie.tech");
});
