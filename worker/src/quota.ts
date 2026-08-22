import { Context } from "hono";

/**
 * 配额（quota）逻辑独立成文件，便于 node --experimental-strip-types --test 直跑单测。
 *
 * 项目约定：可被 node --test 加载的模块**只引 hono**，不带相对路径 import（其它被测
 * 模块如 ingest.ts / api_keys.ts / retention.ts 均如此）——因为相对 import 在
 * strip-types 下要么需要显式 .ts 扩展名、要么撞「裸目录 import」（./models）解析失败。
 * 故本文件把所需常量与 UserSettings 读取逻辑内联，零相对 import。
 *
 * utils.ts 从本文件 re-export 三个函数，调用方仍 import from "../utils"，无破坏。
 * 内联的设置键 / 默认值必须与 constants.ts、models/index.ts UserSettings 保持一致——
 * 修改那两处时同步本文件。
 */

// 与 constants.ts CONSTANTS.USER_SETTINGS_KEY / ROLE_ADDRESS_CONFIG_KEY 同值。
const USER_SETTINGS_KEY = 'user_settings';
const ROLE_ADDRESS_CONFIG_KEY = 'role_address_config';

/**
 * 读 settings 表某 key 的 JSON 值。与 utils.ts getJsonSetting 同实现
 * （读 c.env.DB settings 行 → JSON.parse；坏值/缺值返回 null）。
 */
const getJsonSettingLocal = async <T = any>(
    c: Context<HonoCustomType>, key: string
): Promise<T | null> => {
    const value = await c.env.DB.prepare(
        `SELECT value FROM settings where key = ?`
    ).bind(key).first<string>("value");
    if (!value) return null;
    try {
        return JSON.parse(value) as T;
    } catch (e) {
        console.error(`getJsonSettingLocal: Failed to parse ${key}`, e);
        return null;
    }
};

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
    const roleConfigs = await getJsonSettingLocal<Record<string, any>>(c, ROLE_ADDRESS_CONFIG_KEY);
    if (!roleConfigs) return maxAddressCountFromSettings;
    const roleMaxCount = roleConfigs[userRole]?.maxAddressCount;
    if (typeof roleMaxCount !== 'number') return maxAddressCountFromSettings;
    if (roleMaxCount < 0) return maxAddressCountFromSettings;
    return roleMaxCount;
};

/**
 * 每用户可接入的外部邮箱上限。与 maxAddressCount 同走 role_address_config，
 * 按角色可配（RoleConfig.maxMailAccountCount）。无 role / 无配置 / 负数 → 全局默认 5。
 * 返回 0 = 不限（与 maxAddressCount 同口径）。
 */
const DEFAULT_MAX_MAIL_ACCOUNTS = 5;

export const getMaxMailAccountCount = async (
    c: Context<HonoCustomType>,
    userRole: string | null | undefined
): Promise<number> => {
    if (!userRole) return DEFAULT_MAX_MAIL_ACCOUNTS;
    const roleConfigs = await getJsonSettingLocal<Record<string, any>>(c, ROLE_ADDRESS_CONFIG_KEY);
    if (!roleConfigs) return DEFAULT_MAX_MAIL_ACCOUNTS;
    const v = roleConfigs[userRole]?.maxMailAccountCount;
    if (typeof v !== 'number' || v < 0) return DEFAULT_MAX_MAIL_ACCOUNTS;
    return v;
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
    const value = await getJsonSettingLocal(c, USER_SETTINGS_KEY);
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
