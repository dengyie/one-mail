/**
 * 统一收件箱用户 token 通道（x-user-token）的 401/503 判定（纯函数）。
 *
 * 背景（PR #171 / #172）：D1 瞬时故障曾把「签名/有效期合法的 token」判成无效
 * （isActiveUser 旧实现 catch → false），前端 401 自愈随即清掉 userJwt 并把
 * 用户踢回登录页，表现为 /unified 轮询期间反复掉登录。修复引入三态 liveness
 * 与 userTokenDbError 标志后，本函数把「凭据真的失效」与「后端暂时无法判定」
 * 的分界收拢到一处，可被 node --test 直接覆盖（项目惯例，参照 decideAdminAuth）。
 *
 * 项目约定：被 node --test 加载的模块只引 hono、零相对 import。
 *
 * 输入均为已解析的中间件状态：
 *  - hasUserToken：请求携带 x-user-token（进入本通道的前提，调用方保证）。
 *  - hasPayload：worker.ts 校验链（签名 + exp + isActiveUser）成功写入 userPayload。
 *  - payloadExpired：userPayload 存在但 exp 已过（防御性；正常情况下 worker.ts
 *    中间件不会让过期 payload 进入统一收件箱通道）。
 *  - livenessUnknown：isActiveUser 返回 null（D1 瞬时故障），worker.ts 据此置
 *    userTokenDbError 标志。
 */

export type UserTokenAuthDecision =
    | { relay: true; status: 0 }
    | {
        relay: false;
        status: 401 | 503;
        error: "invalid user token" | "database temporarily unavailable";
        kind: "invalid_token" | "db_unavailable";
    };

export const decideUserTokenAuth = (input: {
    hasUserToken: boolean;
    hasPayload: boolean;
    payloadExpired: boolean;
    livenessUnknown: boolean;
}): UserTokenAuthDecision => {
    if (!input.hasUserToken) {
        // 不携带 x-user-token 时调用方不会进入用户通道；防御性 401。
        return { relay: false, status: 401, error: "invalid user token", kind: "invalid_token" };
    }
    // livenessUnknown 优先于 payload 判定：标志只在「签名与 exp 均合法、仅存活
    // 校验无法完成」时由 worker.ts 置位，此时必须 503（可重试）而非 401。
    if (input.livenessUnknown) {
        return { relay: false, status: 503, error: "database temporarily unavailable", kind: "db_unavailable" };
    }
    if (!input.hasPayload) {
        return { relay: false, status: 401, error: "invalid user token", kind: "invalid_token" };
    }
    if (input.payloadExpired) {
        return { relay: false, status: 401, error: "invalid user token", kind: "invalid_token" };
    }
    return { relay: true, status: 0 };
};
