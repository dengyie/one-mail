import { Context } from "hono";
import { Jwt } from "hono/utils/jwt";
import type { AddressJwtPayload } from "@one-mail/shared";
import { JWT_DEFAULTS } from "@one-mail/shared";

/**
 * 地址 JWT（邮箱客户端长期凭据）签发/校验统一抽象（架构重构 P2，灭 T1+T2）。
 * 仅引 hono + @one-mail/shared，零相对 import（项目测试约束）。
 * AddressJwtPayload 类型来自 @one-mail/shared（唯一来源，不在此内联）。
 *
 * 与原实现行为等价：
 *  - addressJwtExpSeconds 逻辑自 unified/address_token.ts 迁入，原文件保留（Task 9 清理）
 *  - 无 exp 或 exp 过期一律拒绝（H2，移除 REJECT_EXPLESS_JWT 门控）
 *  - verify 内部 try/catch → 失效返回 null；调用方按 null 处理（与原 catch 语义等价）
 */

export const addressJwtExpSeconds = (c: Context): number => {
  const daysRaw = (c.env as any)?.ADDRESS_JWT_TTL_DAYS;
  const days = typeof daysRaw === "number" ? daysRaw
    : typeof daysRaw === "string" && daysRaw.trim() ? Number(daysRaw)
    : JWT_DEFAULTS.ADDRESS_TTL_DAYS;
  const validDays = (typeof days === "number" && days > 0 && Number.isFinite(days))
    ? days : JWT_DEFAULTS.ADDRESS_TTL_DAYS;
  return Math.floor(Date.now() / 1000) + Math.floor(validDays * 86400);
};

export const signAddressJwt = async (
  c: Context,
  payload: { address: string; address_id: number },
): Promise<string> => {
  return await Jwt.sign({ ...payload, exp: addressJwtExpSeconds(c) }, c.env.JWT_SECRET, "HS256");
};

export const verifyAddressJwt = async (
  c: Context,
  token: string,
): Promise<AddressJwtPayload | null> => {
  try {
    const payload = await Jwt.verify(token, c.env.JWT_SECRET, "HS256");
    if (!payload.exp) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload as AddressJwtPayload;
  } catch {
    return null;
  }
};


/**
 * Verify an address credential and its current database binding.
 *
 * Address JWTs are intentionally long-lived, so signature/expiry checks alone
 * would keep a deleted or replaced address usable until token expiry. Checking
 * the id/name pair here revokes credentials when the address row changes and
 * prevents a token for an old row from inheriting a reused address name.
 */
export const verifyActiveAddressJwt = async (
  c: Context,
  token: string,
): Promise<AddressJwtPayload | null> => {
  const payload = await verifyAddressJwt(c, token);
  if (!payload || typeof payload.address !== "string" || !payload.address) {
    return null;
  }

  const rawAddressId = (payload as unknown as { address_id?: unknown }).address_id;
  const addressId = typeof rawAddressId === "number"
    ? rawAddressId
    : Number(rawAddressId);
  if (!Number.isInteger(addressId) || addressId <= 0) {
    return null;
  }

  const row = await c.env.DB.prepare(
    "SELECT name FROM address WHERE id = ?"
  ).bind(addressId).first<{ name: string }>();
  if (!row || row.name !== payload.address) {
    return null;
  }

  return { ...payload, address_id: addressId };
};
