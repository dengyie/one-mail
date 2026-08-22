import { Context } from "hono";

/**
 * Admin 登录失败锁定（Phase 7 / I7c）。
 *
 * 项目约定：被 node --test 加载的模块只引 hono、零相对 import（见 quota.ts）。
 * 按 IP 计数，15min 窗口内 ≥10 次失败则锁定。KV 不可达时 fail-closed（返回 -1 /
 * 直接判定锁定），因为 admin 面是暴力破解主目标——宁可暂拒合法 admin 也别放行爆破。
 * KV 桶 key: adminfail|<ip>|<windowBucket>。
 *
 * 调用方：open_api/auth.ts /open_api/admin_login（交互式登录是主攻击面；
 * 头路径 checkIsAdmin 是共享口令校验，无锁定——见 Phase 7 changelog）。
 */

const WINDOW_SEC = 15 * 60;        // 15 分钟窗口
const MAX_FAILURES = 10;           // 窗口内最大失败次数

const windowBucket = (): number => Math.floor(Date.now() / (WINDOW_SEC * 1000));

const clientIp = (c: Context): string => {
    return c.req.raw.headers.get("cf-connecting-ip")
        || c.req.raw.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
        || "unknown";
};

const bucketKey = (c: Context): string => `adminfail|${clientIp(c)}|${windowBucket()}`;

// 返回当前窗口已失败次数；KV 不可达时返回 -1（调用方据此 fail-closed）。
export const getAdminFailCount = async (c: Context): Promise<number> => {
    if (!c.env.KV) return -1;
    try {
        const raw = await c.env.KV.get(bucketKey(c));
        return raw ? (parseInt(raw, 10) || 0) : 0;
    } catch {
        return -1;
    }
};

// 记录一次失败；返回记录后的失败次数（≥MAX 表示已触发锁定）。
export const recordAdminFailure = async (c: Context): Promise<number> => {
    if (!c.env.KV) return -1;
    try {
        const key = bucketKey(c);
        const raw = await c.env.KV.get(key);
        const count = (raw ? (parseInt(raw, 10) || 0) : 0) + 1;
        await c.env.KV.put(key, String(count), { expirationTtl: WINDOW_SEC + 5 });
        return count;
    } catch {
        return -1;
    }
};

export const clearAdminFailures = async (c: Context): Promise<void> => {
    if (!c.env.KV) return;
    try {
        await c.env.KV.delete(bucketKey(c));
    } catch {
        // best-effort
    }
};

// 是否锁定（≥MAX 或 KV 不可达）。admin 面 fail-closed。
export const isAdminLockedOut = async (c: Context): Promise<boolean> => {
    const count = await getAdminFailCount(c);
    return count < 0 || count >= MAX_FAILURES;
};