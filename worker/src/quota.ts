import type { Context } from "hono";
import { getJsonSetting } from './core/settings.ts';
import { SETTINGS_KEYS } from '@one-mail/shared';

/**
 * 配额（quota）逻辑独立成文件，便于 node --experimental-strip-types --test 直跑单测。
 * settings 表读写本身委托 core/settings.ts（唯一实现）。
 */

/**
 * Mail Service 业务配额。
 *
 * 规则：除 ADMIN_USER_ROLE 外，所有用户都必须有有限额；管理员仅绕过业务数量限制，
 * 但仍受 Worker/D1 的硬安全边界约束（例如单页查询最大 100）。
 */
export const DEFAULT_MAX_ADDRESS_COUNT = 5;
export const DEFAULT_MAX_MAIL_ACCOUNTS = 5;
export const DEFAULT_MAX_UNIFIED_PAGE_SIZE = 50;
export const HARD_MAX_UNIFIED_PAGE_SIZE = 100;

export type MailServiceQuota = {
    /** 0 only means unlimited for the configured admin role. */
    maxMailAccountCount: number;
    /** Always 1..HARD_MAX_UNIFIED_PAGE_SIZE. */
    maxUnifiedPageSize: number;
};

const isAdminRole = (
    c: Context<HonoCustomType>,
    userRole: string | null | undefined,
): boolean => !!c.env.ADMIN_USER_ROLE && userRole === c.env.ADMIN_USER_ROLE;

const readRoleConfigs = async (
    c: Context<HonoCustomType>,
): Promise<Record<string, any> | null> => (
    await getJsonSetting<Record<string, any>>(c, SETTINGS_KEYS.ROLE_ADDRESS_CONFIG)
) || null;

/** Non-admin address quotas are always finite; zero/invalid legacy settings fall back to 5. */
const readMaxAddressCountSetting = (raw: any): number => {
    const v = raw?.maxAddressCount;
    return Number.isInteger(v) && v > 0 ? v : DEFAULT_MAX_ADDRESS_COUNT;
};

export const getMaxAddressCount = async (
    c: Context<HonoCustomType>,
    userRole: string | null | undefined,
    maxAddressCountFromSettings: number
): Promise<number> => {
    if (isAdminRole(c, userRole)) return 0;
    const fallback = Number.isInteger(maxAddressCountFromSettings) && maxAddressCountFromSettings > 0
        ? maxAddressCountFromSettings
        : DEFAULT_MAX_ADDRESS_COUNT;
    if (!userRole) return fallback;
    const roleConfigs = await readRoleConfigs(c);
    const roleMaxCount = roleConfigs?.[userRole]?.maxAddressCount;
    if (!Number.isInteger(roleMaxCount) || roleMaxCount < 1) return fallback;
    return roleMaxCount;
};

/**
 * 每用户可接入的外部邮箱上限。
 * 管理员返回 0（业务上不限）；所有非管理员角色必须返回正整数。
 * 旧配置中的 0、负数、非整数或缺失值都会回退默认 5，避免误配置变成无限资源。
 */
export const getMaxMailAccountCount = async (
    c: Context<HonoCustomType>,
    userRole: string | null | undefined
): Promise<number> => {
    if (isAdminRole(c, userRole)) return 0;
    if (!userRole) return DEFAULT_MAX_MAIL_ACCOUNTS;
    const roleConfigs = await readRoleConfigs(c);
    const v = roleConfigs?.[userRole]?.maxMailAccountCount;
    if (!Number.isInteger(v) || v < 1) return DEFAULT_MAX_MAIL_ACCOUNTS;
    return v;
};

/**
 * Unified Inbox 单次列表页大小。
 * - 普通用户默认 50，可按角色配置 1..100；
 * - 管理员固定使用 Worker 硬上限 100；
 * - 0 永远不表示 unlimited，防止大结果集拖垮 Worker/D1。
 */
export const getMaxUnifiedPageSize = async (
    c: Context<HonoCustomType>,
    userRole: string | null | undefined
): Promise<number> => {
    if (isAdminRole(c, userRole)) return HARD_MAX_UNIFIED_PAGE_SIZE;
    if (!userRole) return DEFAULT_MAX_UNIFIED_PAGE_SIZE;
    const roleConfigs = await readRoleConfigs(c);
    const v = roleConfigs?.[userRole]?.maxUnifiedPageSize;
    if (!Number.isInteger(v) || v < 1 || v > HARD_MAX_UNIFIED_PAGE_SIZE) {
        return DEFAULT_MAX_UNIFIED_PAGE_SIZE;
    }
    return v;
};

export const getMailServiceQuota = async (
    c: Context<HonoCustomType>,
    userRole: string | null | undefined,
): Promise<MailServiceQuota> => {
    const [maxMailAccountCount, maxUnifiedPageSize] = await Promise.all([
        getMaxMailAccountCount(c, userRole),
        getMaxUnifiedPageSize(c, userRole),
    ]);
    return { maxMailAccountCount, maxUnifiedPageSize };
};

/**
 * 检查用户是否已达到地址数量限制。
 * 管理员由 getMaxAddressCount 返回 0 而绕过；非管理员永远得到正整数上限。
 */
export const isAddressCountLimitReached = async (
    c: Context<HonoCustomType>,
    user_id: number | string,
    userRole: string | null | undefined
): Promise<boolean> => {
    const value = await getJsonSetting(c, SETTINGS_KEYS.USER_SETTINGS);
    const maxAddressCount = await getMaxAddressCount(c, userRole, readMaxAddressCountSetting(value));

    if (maxAddressCount <= 0) return false;

    // 只数本站地址，排除外部邮箱归集写入的 source_meta='external' 引用行。
    const { count } = await c.env.DB.prepare(
        `SELECT COUNT(*) as count FROM users_address ua
         JOIN address a ON a.id = ua.address_id
         WHERE ua.user_id = ? AND (a.source_meta IS NULL OR a.source_meta != 'external')`
    ).bind(user_id).first<{ count: number }>() || { count: 0 };

    return count >= maxAddressCount;
};