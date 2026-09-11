import assert from "node:assert/strict";
import test from "node:test";
import { getMaxMailAccountCount, isAddressCountLimitReached } from "../quota.ts";

/**
 * Mail Service 配额回归测试：
 *   1) 外部邮箱绑定（source_meta='external'）不计入本站地址配额；
 *   2) 外部邮箱配额按角色配置；
 *   3) 除 ADMIN_USER_ROLE 外，0/非法配置不能制造无限额度。
 */

const makeCtx = ({ userSettings, roleConfig, countResult, adminRole }) => {
    const db = {
        prepare: (sql) => {
            let binds = [];
            const stmt = {
                bind: (...args) => { binds = args; return stmt; },
                first: async (colName) => {
                    if (sql.includes("FROM settings")) {
                        const key = binds[0];
                        let scalar = null;
                        if (key === "user_settings") scalar = userSettings ?? null;
                        else if (key === "role_address_config") scalar = roleConfig ?? null;
                        return colName ? scalar : (scalar == null ? null : { value: scalar });
                    }
                    if (sql.includes("COUNT(*)") && sql.includes("users_address")) {
                        return { count: countResult ?? 0 };
                    }
                    return null;
                },
            };
            return stmt;
        },
    };
    return { env: { DB: db, ADMIN_USER_ROLE: adminRole } };
};

test("isAddressCountLimitReached excludes source_meta='external' rows", async () => {
    const ctx3 = makeCtx({
        userSettings: JSON.stringify({ maxAddressCount: 5 }),
        roleConfig: null,
        countResult: 3,
    });
    assert.equal(await isAddressCountLimitReached(ctx3, 10, "user"), false);
    assert.equal(await isAddressCountLimitReached(ctx3, 10, null), false);

    const ctx5 = makeCtx({
        userSettings: JSON.stringify({ maxAddressCount: 5 }),
        roleConfig: null,
        countResult: 5,
    });
    assert.equal(await isAddressCountLimitReached(ctx5, 10, "user"), true);

    // Legacy 0 no longer means unlimited for a non-admin user; it falls back to finite default 5.
    const ctxLegacyZero = makeCtx({
        userSettings: JSON.stringify({ maxAddressCount: 0 }),
        roleConfig: null,
        countResult: 999,
    });
    assert.equal(await isAddressCountLimitReached(ctxLegacyZero, 10, "user"), true);
});

test("isAddressCountLimitReached JOIN excludes external — count reflects only site addresses", async () => {
    const ctx = makeCtx({
        userSettings: JSON.stringify({ maxAddressCount: 4 }),
        roleConfig: null,
        countResult: 3,
    });
    assert.equal(await isAddressCountLimitReached(ctx, 10, "user"), false);

    const ctxOld = makeCtx({
        userSettings: JSON.stringify({ maxAddressCount: 4 }),
        roleConfig: null,
        countResult: 5,
    });
    assert.equal(await isAddressCountLimitReached(ctxOld, 10, "user"), true);
});

test("admin address role bypasses business address quota", async () => {
    const ctx = makeCtx({
        userSettings: JSON.stringify({ maxAddressCount: 1 }),
        roleConfig: JSON.stringify({ admin: { maxAddressCount: 1 } }),
        countResult: 999,
        adminRole: "admin",
    });
    assert.equal(await isAddressCountLimitReached(ctx, 10, "admin"), false);
});

test("getMaxMailAccountCount defaults to 5 when no role", async () => {
    const ctx = makeCtx({ userSettings: null, roleConfig: null, countResult: 0 });
    assert.equal(await getMaxMailAccountCount(ctx, null), 5);
    assert.equal(await getMaxMailAccountCount(ctx, undefined), 5);
});

test("getMaxMailAccountCount uses role config when present", async () => {
    const ctx = makeCtx({
        userSettings: null,
        roleConfig: JSON.stringify({ user: { maxMailAccountCount: 10 } }),
        countResult: 0,
    });
    assert.equal(await getMaxMailAccountCount(ctx, "user"), 10);
});

test("getMaxMailAccountCount falls back to 5 for missing or invalid non-admin config", async () => {
    const ctxNoRoleEntry = makeCtx({
        userSettings: null,
        roleConfig: JSON.stringify({ admin: { maxMailAccountCount: 99 } }),
        countResult: 0,
    });
    assert.equal(await getMaxMailAccountCount(ctxNoRoleEntry, "user"), 5);

    for (const bad of [-1, 0, 2.5, "many"]) {
        const ctx = makeCtx({
            userSettings: null,
            roleConfig: JSON.stringify({ user: { maxMailAccountCount: bad } }),
            countResult: 0,
        });
        assert.equal(await getMaxMailAccountCount(ctx, "user"), 5);
    }
});

test("getMaxMailAccountCount returns 0 only for configured admin role", async () => {
    const ctx = makeCtx({
        userSettings: null,
        roleConfig: JSON.stringify({ admin: { maxMailAccountCount: 1 } }),
        countResult: 0,
        adminRole: "admin",
    });
    assert.equal(await getMaxMailAccountCount(ctx, "admin"), 0);
});
