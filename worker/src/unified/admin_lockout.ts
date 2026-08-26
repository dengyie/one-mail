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

/* ----------------------------------- R2 ----------------------------------- */

/**
 * R2（CRITICAL）：/admin/* 授权的纯函数判定——user-role 兜底不再构成授权面。
 *
 * 项目约定：被 node --test 加载的模块只引 hono、零相对 import。worker.ts 调用方
 * 后可相对 import。把「admin 中间件」的判定抽成无副作用纯函数，使 R2 组合门
 * （头通道 + 锁定）可被单测直接覆盖。
 *
 * 语义（与 worker.ts /admin/* 中间件逐字对齐）：
 *  1. 有过admin凭据（x-admin-auth 或 x-user-access-token）且已锁定/ KV 不可达
 *     → 429，不再校验凭据（fail-closed）。
 *  2. x-admin-auth 校验通过 → 放行（调用方负责清失败计数）。
 *  3. 头通道失败后：user-role 兜底（x-user-access-token + ADMIN_USER_ROLE）——
 *     除「签名校验抛错」走 disable 逃生舱外，所有情况（过期/角色不符/角色命中但
 *     缺头通道）一律 401 且计失败。user_role 仅作前端 UX 信号，不构成授权面。
 *  4. DISABLE_ADMIN_PASSWORD_CHECK（运维显式逃生舱）→ 放行。
 *  5. 其余 → 401（NeedAdminPassword）。
 */

export type AdminAuthCheckInput = {
  hasAdminAuth: boolean;
  hasAccessToken: boolean;
  adminAuthValid: boolean;   // checkIsAdmin(c) 结果
  adminFailCount: number;    // -1 = KV 不可达（fail-closed 视同锁定）
  adminUserRole: string | undefined;
  disableAdminPasswordCheck: boolean;
  // x-user-access-token verify 结果；null = verify 抛错（签名无效）。
  accessTokenPayload: { exp?: number; user_role?: unknown } | null;
};

export type AdminAuthDecision =
  | { relay: true; status: 0 }
  | {
      relay: false;
      status: number;          // 401 | 429
      recordFailure: boolean;  // 是否记录一次失败（计入同一 IP 失败桶）
      kind: "rate_limit" | "access_token_expired" | "role_not_admin" | "need_admin_password";
    };

export const decideAdminAuth = (input: AdminAuthCheckInput): AdminAuthDecision => {
  const locked = input.adminFailCount < 0 || input.adminFailCount >= MAX_FAILURES;

  // (1) 锁定门：有 admin 凭据的请求在锁定窗口内 → 429（KV 不可达 fail-closed）
  if ((input.hasAdminAuth || input.hasAccessToken) && locked) {
    return { relay: false, status: 429, recordFailure: false, kind: "rate_limit" };
  }

  // (2) 头通道命中 → 放行（调用方负责 clearAdminFailures）
  if (input.adminAuthValid) {
    return { relay: true, status: 0 };
  }

  // 记录头通道失败（x-admin-auth 校验不过且携带该头）
  let recordFailure = input.hasAdminAuth;

  // (3) R2：user-role 兜底不再放行授权面
  if (input.adminUserRole && input.hasAccessToken) {
    const payload = input.accessTokenPayload;
    if (payload === null) {
      // verify 抛错（无效签名/过期签名异常）→ 继续走逃生舱判定，先计失败
      recordFailure = true;
    } else {
      const expired = !payload.exp || payload.exp < Math.floor(Date.now() / 1000);
      if (expired) {
        return { relay: false, status: 401, recordFailure: true, kind: "access_token_expired" };
      }
      if (payload.user_role !== input.adminUserRole) {
        return { relay: false, status: 401, recordFailure: true, kind: "role_not_admin" };
      }
      // user_role 确为 ADMIN_USER_ROLE（管理员账户已通过 user_token / access_token 登录认证），
      // 直接免密放行，允许通过账户角色直接进入管理员后台管理。
      return { relay: true, status: 0 };
    }
  }

  // (4) 运维显式逃生舱
  if (input.disableAdminPasswordCheck) {
    return { relay: true, status: 0 };
  }

  return { relay: false, status: 401, recordFailure, kind: "need_admin_password" };
};