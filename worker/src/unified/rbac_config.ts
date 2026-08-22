// 角色地址配额配置（role_address_config）相关的纯逻辑抽到本文件，便于 node --test 直跑单测。
//
// 项目约定：可被 node --test 加载的模块**只引 hono**、零相对 import（见 quota.ts；
// utils.ts 经 gzip→models 的 type-only 值 import 在 --experimental-strip-types 下炸）。
// 本文件只含纯函数，连 hono 都不用引，零 import，可直接被 .test.mjs 导入。

/**
 * 合并既有的 role_address_config 与本次提交的 configs（PATCH 语义）：
 * incoming 中的 role 键覆盖既有同名 role 对象；incoming 未提及的 role 保留。
 * 这样两个 admin 并发配置不同 role 不会互相覆盖（C2）。
 * 纯函数，便于单测。
 */
export const mergeRoleAddressConfigs = (
    existing: Record<string, any> | null | undefined,
    incoming: Record<string, any>
): Record<string, any> => {
    return { ...(existing ?? {}), ...incoming };
};