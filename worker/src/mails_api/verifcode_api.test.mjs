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

const { listVerifCodes, getLatestVerifCode, fetchAddressVerifCodes } = await import("./verifcode_api.ts");

const makeCtx = ({ address = "agent@dengyie.tech", query = {}, emailRows = [], rawRows = [] } = {}) => {
    let capturedEmailSql = null;
    let capturedRawSql = null;

    const db = {
        prepare(sql) {
            let binds = [];
            const stmt = {
                bind(...args) {
                    binds = args;
                    if (sql.includes("FROM emails")) {
                        capturedEmailSql = { sql, binds };
                    } else if (sql.includes("FROM raw_mails")) {
                        capturedRawSql = { sql, binds };
                    }
                    return stmt;
                },
                async all() {
                    if (sql.includes("FROM emails")) {
                        return { results: emailRows };
                    }
                    return { results: [] };
                },
                async first() {
                    return null;
                },
            };
            return stmt;
        },
    };

    const c = {
        req: {
            query: (key) => (key ? query[key] : query),
        },
        env: { DB: db },
        get: (key) => (key === "jwtPayload" ? (address ? { address, address_id: 1 } : null) : undefined),
        json: (body, status) => ({ body, status }),
        text: (body, status) => ({ body, status }),
        // For listRawMails mock in fallback
        _mockRawRows: rawRows,
    };

    return { c, getCapturedEmail: () => capturedEmailSql, getCapturedRaw: () => capturedRawSql };
};

test("verifcode_api listVerifCodes returns 400 when no address in jwtPayload", async () => {
    const { c } = makeCtx({ address: null });
    const res = await listVerifCodes(c);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "No address" });
});

test("verifcode_api listVerifCodes queries emails table with bounded projection", async () => {
    const emailRows = [
        {
            subject: "Your GitHub verification code is 887766",
            text_body: "Please enter 887766 to complete verification.",
            html_body: "",
            from_addr: "support@github.com",
            to_addr: "agent@dengyie.tech",
            received_at: Date.now() - 5000,
            source: "cf_routing",
        },
    ];

    const { c, getCapturedEmail } = makeCtx({
        address: "Agent@dengyie.tech",
        query: { fresh: "10", limit: "5" },
        emailRows,
    });

    const res = await listVerifCodes(c);
    assert.equal(res.body.results.length, 1);
    assert.equal(res.body.results[0].code, "887766");
    assert.equal(res.body.results[0].to_addr, "agent@dengyie.tech");
    assert.equal(res.body.results[0].from_addr, "support@github.com");

    const captured = getCapturedEmail();
    assert.ok(captured.sql.includes("substr(text_body, 1, 3000)"), "must truncate projection");
    assert.ok(captured.sql.includes("to_addr = ? AND received_at >= ?"), "must use to_addr and received_at");
    assert.equal(captured.binds[0], "agent@dengyie.tech", "address must be normalized to lowercase");
    assert.ok(typeof captured.binds[1] === "number", "since timestamp must be number");
});

test("verifcode_api getLatestVerifCode returns single object or code: null", async () => {
    // 1. With code present
    const emailRows = [
        {
            subject: "Security code: 543210",
            text_body: "Your security code is 543210",
            html_body: "",
            from_addr: "noreply@example.com",
            to_addr: "user@mangoqwq.tech",
            received_at: 1740000000000,
            source: "cf_routing",
        },
    ];
    const { c: c1 } = makeCtx({ address: "user@mangoqwq.tech", emailRows });
    const res1 = await getLatestVerifCode(c1);
    assert.equal(res1.body.code, "543210");
    assert.equal(res1.body.to_addr, "user@mangoqwq.tech");
    assert.equal(res1.body.received_at, 1740000000000);

    // 2. Without code present
    const { c: c2 } = makeCtx({ address: "user@mangoqwq.tech", emailRows: [] });
    const res2 = await getLatestVerifCode(c2);
    assert.deepEqual(res2.body, { code: null });
});

test("verifcode_api parses fresh minutes and milliseconds properly", async () => {
    const { c, getCapturedEmail } = makeCtx({
        address: "user@dengyie.tech",
        query: { fresh: "60" }, // 60 minutes
    });

    const now = Date.now();
    await fetchAddressVerifCodes(c, "user@dengyie.tech", "60", "10");
    const captured = getCapturedEmail();
    const since = captured.binds[1];
    // since should be approx now - 60 * 60 * 1000
    const diffMin = Math.round((now - since) / 60000);
    assert.equal(diffMin, 60);
});
