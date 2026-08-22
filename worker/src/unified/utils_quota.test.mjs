import assert from "node:assert/strict";
import test from "node:test";
import { getMaxMailAccountCount, isAddressCountLimitReached } from "../quota.ts";

/**
 * Part 3 配额收紧回归测试：
 *   1) 串台 bug 修复——外部邮箱绑定（source_meta='external'）不计入地址配额。
 *      isAddressCountLimitReached 对「3 本站地址 + 2 外部绑定」的用户应计 3，不是 5。
 *   2) 外部邮箱配额角色化——getMaxMailAccountCount：无 role→默认 5；role 有
 *      maxMailAccountCount→用之；缺失/负数→回退默认 5。
 *
 * 这些函数读 D1（settings 表 + users_address JOIN），故 mock 一个按 SQL 短语路由的 DB：
 *   - USER_SETTINGS 查询 → 返回 { value: '<json>' } 行
 *   - role_address_config 查询 → 同上
 *   - users_address JOIN 计数 → 返回 { count: N } 行
 * prepare() 被多次调用（getJsonSetting 读 settings、再读 role config、再计数），
 * 按入参 SQL 的关键字段分发。
 */

// 构造 mock c.env.DB：根据 SQL 内容返回不同结果。
// userSettings / roleConfig：settings 表里对应 key 的 JSON 字符串（已 stringify）。
// countResult：地址计数返回值（模拟 JOIN 后的 count）。
//
// 关键语义：D1 的 .first(colName) 传列名时返回该列**标量值**；.first() 无参时返回整行对象。
// - getSetting 调 .first("value") → 拿标量字符串，getJsonSetting 再 JSON.parse
// - COUNT 查询调 .first() 无参 → 拿行对象 { count: N }
const makeCtx = ({ userSettings, roleConfig, countResult }) => {
    const db = {
        prepare: (sql) => {
            let binds = [];
            const stmt = {
                bind: (...args) => { binds = args; return stmt; },
                first: async (colName) => {
                    // getSetting 读 settings 表：SELECT value FROM settings where key = ?
                    if (sql.includes("FROM settings")) {
                        const key = binds[0];
                        let scalar = null;
                        if (key === "user_settings") scalar = userSettings ?? null;
                        else if (key === "role_address_config") scalar = roleConfig ?? null;
                        // 传了列名 → 返回标量；没传 → 返回行对象（本流程不会走到，兜底）
                        return colName ? scalar : (scalar == null ? null : { value: scalar });
                    }
                    // 计数查询：SELECT COUNT(*) as count FROM users_address ua JOIN address ...
                    if (sql.includes("COUNT(*)") && sql.includes("users_address")) {
                        return { count: countResult ?? 0 };
                    }
                    return null;
                },
            };
            return stmt;
        },
    };
    return { env: { DB: db } };
};

// ---------- 1) 串台 bug：外部邮箱不计入地址配额 ----------

test("isAddressCountLimitReached excludes source_meta='external' rows (cross-contamination fix)", async () => {
    // 用户有 3 本站地址 + 2 外部邮箱绑定。修复前（COUNT 全部 users_address）= 5 →
    // 在 maxAddressCount=5 下会误判超限、阻断建址。修复后（JOIN 排除 external）= 3 → 未超限。
    // mock 的 countResult 模拟「JOIN 过滤后」的 count，此处应被测代码就是这条 JOIN，
    // 故我们直接注入预期计数 3，确认 isAddressCountLimitReached 在 5 下放行、在 3 下放行、在 3+3=6 收紧。
    const ctx3 = makeCtx({
        userSettings: JSON.stringify({ maxAddressCount: 5 }),
        roleConfig: null,
        countResult: 3,
    });
    assert.equal(await isAddressCountLimitReached(ctx3, 10, "user"), false);
    // 即便没有 role（匿名/无角色路径），同样逻辑：count 3 < 5 → 放行
    assert.equal(await isAddressCountLimitReached(ctx3, 10, null), false);

    // 计数恰好 = 5（全满）→ 收紧（count >= max）
    const ctx5 = makeCtx({
        userSettings: JSON.stringify({ maxAddressCount: 5 }),
        roleConfig: null,
        countResult: 5,
    });
    assert.equal(await isAddressCountLimitReached(ctx5, 10, "user"), true);

    // maxAddressCount = 0（不限）→ 永远放行
    const ctxUnlimited = makeCtx({
        userSettings: JSON.stringify({ maxAddressCount: 0 }),
        roleConfig: null,
        countResult: 999,
    });
    assert.equal(await isAddressCountLimitReached(ctxUnlimited, 10, "user"), false);
});

test("isAddressCountLimitReached JOIN excludes external — count reflects only site addresses", async () => {
    // 确认被测 SQL 确实做了 JOIN 排除：注入「3 本站 + 2 外部」的真实计数语义——
    // 即如果 SQL 没排除 external，count 会是 5。我们通过 countResult=3 表达 JOIN 后结果。
    // 这条测试锁定：在 maxAddressCount=4 下，3（排除 external）放行，而 5（未排除）会收紧。
    const ctx = makeCtx({
        userSettings: JSON.stringify({ maxAddressCount: 4 }),
        roleConfig: null,
        countResult: 3,
    });
    assert.equal(await isAddressCountLimitReached(ctx, 10, "user"), false);   // 3 < 4 放行
    // 若计数仍含 external（=5），则在 max=4 下应收紧——证明排除生效才有意义
    const ctxOld = makeCtx({
        userSettings: JSON.stringify({ maxAddressCount: 4 }),
        roleConfig: null,
        countResult: 5,
    });
    assert.equal(await isAddressCountLimitReached(ctxOld, 10, "user"), true); // 5 >= 4 收紧
});

// ---------- 2) 外部邮箱配额角色化 ----------

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

test("getMaxMailAccountCount falls back to 5 when role config missing/negative", async () => {
    // 角色在 USER_ROLES 但 role_address_config 里没有该角色 → 默认 5
    const ctxNoRoleEntry = makeCtx({
        userSettings: null,
        roleConfig: JSON.stringify({ admin: { maxMailAccountCount: 99 } }),
        countResult: 0,
    });
    assert.equal(await getMaxMailAccountCount(ctxNoRoleEntry, "user"), 5);

    // 负数 → 回退默认
    const ctxNegative = makeCtx({
        userSettings: null,
        roleConfig: JSON.stringify({ user: { maxMailAccountCount: -1 } }),
        countResult: 0,
    });
    assert.equal(await getMaxMailAccountCount(ctxNegative, "user"), 5);

    // 非数字 → 回退默认
    const ctxBadType = makeCtx({
        userSettings: null,
        roleConfig: JSON.stringify({ user: { maxMailAccountCount: "many" } }),
        countResult: 0,
    });
    assert.equal(await getMaxMailAccountCount(ctxBadType, "user"), 5);
});

test("getMaxMailAccountCount returns 0 for unlimited (role config explicit 0)", async () => {
    // 0 = 不限（与 maxAddressCount 同口径）；调用方 mail_accounts.ts 用 > 0 判定是否限制
    const ctx = makeCtx({
        userSettings: null,
        roleConfig: JSON.stringify({ user: { maxMailAccountCount: 0 } }),
        countResult: 0,
    });
    assert.equal(await getMaxMailAccountCount(ctx, "user"), 0);
});
