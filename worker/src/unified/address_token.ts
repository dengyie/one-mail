import { Context } from "hono";

/**
 * 地址 JWT 过期时间（Phase 7 / I7a）。
 *
 * 项目约定：被 node --test 加载的模块只引 hono、零相对 import（见 quota.ts）。
 * 地址 JWT 是邮箱客户端（SMTP/IMAP 代理、münchen)长期凭据——用户注册临时域名地址后
 * 在客户端里配一次就不再换；若用 user JWT 的 30d 一把梭，用户每 30 天要重新登录一次，
 * 引发「客户端重认证风暴」，收益低。故默认 90 天，可通过 env ADDRESS_JWT_TTL_DAYS 覆盖。
 *
 * 调用方（newAddress / showPassword / getBindedAddressJwt / address_login）都是请求处理器，
 * c 在作用域内，直接传 c 取 env。
 */

const DEFAULT_ADDRESS_JWT_TTL_DAYS = 90;

export const addressJwtExpSeconds = (c: Context): number => {
    const daysRaw = (c.env as any)?.ADDRESS_JWT_TTL_DAYS;
    const days = typeof daysRaw === "number" ? daysRaw
        : typeof daysRaw === "string" && daysRaw.trim() ? Number(daysRaw)
        : DEFAULT_ADDRESS_JWT_TTL_DAYS;
    // 非法/非正数 → 默认 90，避免误配致 token 立即过期或永不过期
    const validDays = (typeof days === "number" && days > 0 && Number.isFinite(days)) ? days : DEFAULT_ADDRESS_JWT_TTL_DAYS;
    return Math.floor(Date.now() / 1000) + Math.floor(validDays * 86400);
};