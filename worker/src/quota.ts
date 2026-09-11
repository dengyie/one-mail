import type { Context } from "hono";
import { getJsonSetting } from './core/settings.ts';
import { SETTINGS_KEYS } from '@one-mail/shared';

/**
 * 配额（quota）逻辑独立成文件，便于 node --experimental-strip-types --test 直跑单测。
 *
 * settings 键值以 `@one-mail/shared` 的 SETTINGS_KEYS 为准。
 * settings 表读写本身委托 core/settings.ts（唯一实现，零 T3 双份 SQL）。
 *
 * utils.ts 从本文件 re-export，调用方仍可 import from "../utils"，无破坏。
 */

/**
 * Mail Service 业务配额。
 *
 * 普通用户必须有有限额默认值；管理员只绕过「业务数量」限制，但仍受 Worker/D1
 * 的硬安全边界约束（例如单页查询最大 100），避免一次请求把 Worker 打爆。
 */
export const DEFAULT_MAX_MAIL_ACCOUNTS = 5;
export const DEFAULT_MAX_UNIFIED_PAGE_SIZE = 50;
export const HARD_MAX_UNIFIED_PAGE_SIZE = 100;

export type MailServiceQuota = {
    /** 0 = unlimited (admin or role explicitly unlimited). */
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

/**
 * 读 user_settings.maxAddressCount，复制 models/index.ts UserSettings 构造逻辑：
 * 非 number 或 < 0 → 默认 5。与 new UserSettings(value).maxAddressCount 同口径。
 */
const readMaxAddressCountSetting = (raw: any): number => {
    const v = raw?.maxAddressCount;
    return (typeof v === "number" && v >= 0) ? v : 5;
};

export const getMaxAddressCount = async (
    c: Context<HonoCustomType>,
    userRole: string | null | undefined,
    maxAddressCountFromSettings: number
): Promise<number> => {
    if (!userRole) return maxAddressCountFromSettings;
    const roleConfigs = await readRoleConfigs(c);
    if (!roleConfigs) return maxAddressCountFromSettings;
    const roleMaxCount = roleConfigs[userRole]?.maxAddressCount;
    if (typeof roleMaxCount !== 'number') return maxAddressCountFromSettings;
    if (roleMaxCount < 0) return maxAddressCountFromSettings;
    return roleMaxCount;
};

/**
 * 每用户可接入的外部邮箱上限。与 maxAddressCount 同走 role_address_config，
 * 按角色可配（RoleConfig.maxMailAccountCount）。无 role / 无配置 / 负数 → 默认 5。
 *
 * 管理员角色无条件返回 0（不限），避免后台管理员被普通用户资源配额误伤。
 * 普通角色显式配置 0 仍表示不限，便于后续提供付费/可信角色。
 */
export const getMaxMailAccountCount = async (
    c: Context<HonoCustomType>,
    userRole: string | null | undefined
): Promise<number> => {
    if (isAdminRole(c, userRole)) return 0;
    if (!userRole) return DEFAULT_MAX_MAIL_ACCOUNTS;
    const roleConfigs = await readRoleConfigs(c);
    if (!roleConfigs) return DEFAULT_MAX_MAIL_ACCOUNTS;
    const v = roleConfigs[userRole]?.maxMailAccountCount;
    if (typeof v !== 'number' || v < 0) return DEFAULT_MAX_MAIL_ACCOUNTS;
    return v;
};

/**
 * Unified Inbox 单次列表页大小。
 *
 * - 普通用户默认 50，可按角色收紧/放宽，但只能在 1..100 内；
 * - 管理员固定使用 Worker 硬上限 100；
 * - 0 不表示 unlimited：分页请求必须永远有硬上限，防止大结果集拖垮 Worker/D1。
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
    // Intentionally resolve independently. The settings row is tiny and D1 may cache reads;
    // keeping the public helpers independent avoids hidden coupling for existing callers.
    const [maxMailAccountCount, maxUnifiedPageSize] = await Promise.all([
        getMaxMailAccountCount(c, userRole),
        getMaxUnifiedPageSize(c, userRole),
    ]);
    return { maxMailAccountCount, maxUnifiedPageSize };
};

/**
 * 检查用户是否已达到地址数量限制
 *
 * I7e 说明（TOCTOU accept-low）：此处的 SELECT COUNT 与调用方后续的 INSERT 是两条独立
 * D1 语句，并发场景下两个请求可能都过检查都插入，地址数瞬时超限 1 条。此处**有意不修**：
 *   1) 超限只 +1，且有界 —— 竞态后下一建址请求在本检查的 `>=` 下被挡，直到用户删掉
 *      超的那条才放行，不会滚雪球；
 *   2) 加 KV 锁会引入分布式锁依赖而不真正串行化 D1 写者（同 worker 多并发实例下
 *      KV 锁跨实例也不可靠）；
 *   3) D1 无 per-user 唯一约束可借用（address 是全局 name 唯一，不是 per-user）。
 * 故接受该瞬态：一个地址的竞态溢出。若后续需要硬上限，应走「INSERT 后补偿重数 +
 * 超限删行」的路径（见 mail_accounts.ts create 的 I7e 补偿，那里 blast radius 更低）。
 *
 * @param c - Hono Context
 * @param user_id - 用户 ID
 * @param userRole - 用户角色
 * @returns true 表示已超限，false 表示未超限
 */
export const isAddressCountLimitReached = async (
    c: Context<HonoCustomType>,
    user_id: number | string,
    userRole: string | null | undefined
): Promise<boolean> => {
    const value = await getJsonSetting(c, SETTINGS_KEYS.USER_SETTINGS);
    const maxAddressCount = await getMaxAddressCount(c, userRole, readMaxAddressCountSetting(value));

    if (maxAddressCount <= 0) return false;

    // 只数本站地址，排除外部邮箱归集写入的 source_meta='external' 引用行
    // （ensureExternalBinding 在 mail_accounts.ts 给 users_address 写的占位绑定，
    // 仅作 join 用，不参与建址/收信）。否则用户接入的外部邮箱会偷占 maxAddressCount
    // 配额——与 mail_accounts.ts 顶部「外部邮箱独立计数、不消耗地址配额」的承诺一致。
    // 与 admin_api/address_api.ts list/count、email/index.ts 未知地址拦截同口径。
    const { count } = await c.env.DB.prepare(
        `SELECT COUNT(*) as count FROM users_address ua
         JOIN address a ON a.id = ua.address_id
         WHERE ua.user_id = ? AND (a.source_meta IS NULL OR a.source_meta != 'external')`
    ).bind(user_id).first<{ count: number }>() || { count: 0 };

    return count >= maxAddressCount;
};