import assert from "node:assert/strict";
import test from "node:test";

import {
    DEFAULT_MAX_MAIL_ACCOUNTS,
    DEFAULT_MAX_UNIFIED_PAGE_SIZE,
    HARD_MAX_UNIFIED_PAGE_SIZE,
    getMailServiceQuota,
    getMaxMailAccountCount,
    getMaxUnifiedPageSize,
} from "../quota.ts";

const makeCtx = ({ roleConfig = null, adminRole } = {}) => {
    const db = {
        prepare(sql) {
            let binds = [];
            const stmt = {
                bind(...args) { binds = args; return stmt; },
                async first(colName) {
                    if (!sql.includes("FROM settings")) return null;
                    const key = binds[0];
                    const value = key === "role_address_config" ? roleConfig : null;
                    return colName ? value : (value == null ? null : { value });
                },
            };
            return stmt;
        },
    };
    return { env: { DB: db, ADMIN_USER_ROLE: adminRole } };
};

test("normal users receive finite default mail service quotas", async () => {
    const c = makeCtx();
    assert.equal(await getMaxMailAccountCount(c, "user"), DEFAULT_MAX_MAIL_ACCOUNTS);
    assert.equal(await getMaxUnifiedPageSize(c, "user"), DEFAULT_MAX_UNIFIED_PAGE_SIZE);
    assert.deepEqual(await getMailServiceQuota(c, "user"), {
        maxMailAccountCount: DEFAULT_MAX_MAIL_ACCOUNTS,
        maxUnifiedPageSize: DEFAULT_MAX_UNIFIED_PAGE_SIZE,
    });
});

test("role-specific mail service quotas are applied", async () => {
    const c = makeCtx({
        roleConfig: JSON.stringify({
            pro: { maxMailAccountCount: 20, maxUnifiedPageSize: 80 },
        }),
    });
    assert.equal(await getMaxMailAccountCount(c, "pro"), 20);
    assert.equal(await getMaxUnifiedPageSize(c, "pro"), 80);
});

test("admin bypasses business account quota but keeps Worker hard page ceiling", async () => {
    const c = makeCtx({
        adminRole: "admin",
        roleConfig: JSON.stringify({
            admin: { maxMailAccountCount: 1, maxUnifiedPageSize: 1 },
        }),
    });
    assert.equal(await getMaxMailAccountCount(c, "admin"), 0);
    assert.equal(await getMaxUnifiedPageSize(c, "admin"), HARD_MAX_UNIFIED_PAGE_SIZE);
    assert.deepEqual(await getMailServiceQuota(c, "admin"), {
        maxMailAccountCount: 0,
        maxUnifiedPageSize: HARD_MAX_UNIFIED_PAGE_SIZE,
    });
});

test("invalid page quota never becomes unlimited", async () => {
    for (const bad of [0, -1, 101, 2.5, "100"]) {
        const c = makeCtx({
            roleConfig: JSON.stringify({ user: { maxUnifiedPageSize: bad } }),
        });
        assert.equal(
            await getMaxUnifiedPageSize(c, "user"),
            DEFAULT_MAX_UNIFIED_PAGE_SIZE,
            `bad value ${JSON.stringify(bad)} must fall back to finite default`,
        );
    }
});

test("explicit zero mail-account quota retains existing unlimited role semantics", async () => {
    const c = makeCtx({
        roleConfig: JSON.stringify({ user: { maxMailAccountCount: 0 } }),
    });
    assert.equal(await getMaxMailAccountCount(c, "user"), 0);
});
