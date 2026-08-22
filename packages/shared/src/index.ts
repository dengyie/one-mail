/** one-mail 共享契约：常量（预编译 dist/，供 worker strip-types 测试经 node_modules 解析）+ 类型（仅 `import type` 消费，strip-types 擦除） */
export const API_PATHS = {
  ADDRESS: "/api",
  USER: "/user_api",
  ADMIN: "/admin",
  OPEN: "/open_api",
  TELEGRAM: "/telegram",
  EXTERNAL: "/external",
  UNIFIED: "/api/unified",
  UNIFIED_ADMIN: "/admin/unified",
} as const;

export const SETTINGS_KEYS = {
  USER_SETTINGS: "user_settings",
  ROLE_ADDRESS_CONFIG: "role_address_config",
} as const;

export const JWT_DEFAULTS = {
  ADDRESS_TTL_DAYS: 90,
} as const;

/** 地址 JWT 载荷（核心类型，worker core/auth 与调用方共用；签名者/校验者各自按需取字段） */
export interface AddressJwtPayload {
  address: string;
  address_id: number;
  exp?: number;
}

/** 前端 API 路径前缀（createApiClient 的 JSDoc 标注用；运行时不引用） */
export type ApiPath =
  | "/api"
  | "/user_api"
  | "/admin"
  | "/open_api"
  | "/telegram"
  | "/external"
  | "/api/unified"
  | "/admin/unified";
