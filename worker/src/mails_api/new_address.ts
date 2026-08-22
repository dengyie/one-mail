import { Context } from 'hono'

import i18n from '../i18n';
import { getBooleanValue, getJsonSetting, isAddressCountLimitReached } from '../utils';
import { newAddress, getAddressPrefix, generateRandomName } from '../common'
import { CONSTANTS } from '../constants'

const createNewAddress = async (c: Context<HonoCustomType>) => {
    const msgs = i18n.getMessagesbyContext(c);
    const userPayload = c.get("userPayload");

    // I6 fail-closed：env 未设置时按 true 处理（文档默认即 true），消除配置遗漏暴露；
    // 显式设 false/"0"/"false" 才允许匿名建址（保留显式 opt-in 出口）。
    const anonymousForbidden = c.env.DISABLE_ANONYMOUS_USER_CREATE_EMAIL === undefined
        ? true
        : getBooleanValue(c.env.DISABLE_ANONYMOUS_USER_CREATE_EMAIL);
    if (anonymousForbidden
        && !userPayload
    ) {
        return c.text(msgs.NewAddressAnonymousDisabledMsg, 403)
    }
    if (!getBooleanValue(c.env.ENABLE_USER_CREATE_EMAIL)) {
        return c.text(msgs.NewAddressDisabledMsg, 403)
    }

    // 如果启用了禁止匿名创建，且用户已登录，检查地址数量限制
    if (anonymousForbidden && userPayload) {
        const userRole = c.get("userRolePayload");
        if (await isAddressCountLimitReached(c, userPayload.user_id, userRole)) {
            return c.text(msgs.MaxAddressCountReachedMsg, 400)
        }
    }

    // Turnstile 已从此处移除（2026-08-22 收紧到只守注册接口）：
    // 建址在生产已受 DISABLE_ANONYMOUS_USER_CREATE_EMAIL 强制登录 + 数量限制 +
    // checkRegistrationRateLimit 限流三重防护，盾对建址属于多余摩擦。
    // 仍读 cf_token 以兼容旧前端，但不再校验。
    // eslint-disable-next-line prefer-const
    let { name, domain, enableRandomSubdomain } = await c.req.json();
    // Check if custom email names are disabled from environment variable
    const disableCustomAddressName = getBooleanValue(c.env.DISABLE_CUSTOM_ADDRESS_NAME);

    // if no name or custom names are disabled, generate random name
    if (!name || disableCustomAddressName) {
        name = generateRandomName(c);
    }
    // check name block list
    try {
        const value = await getJsonSetting(c, CONSTANTS.ADDRESS_BLOCK_LIST_KEY);
        const blockList = (value || []) as string[];
        if (blockList.some((item) => name.includes(item))) {
            return c.text(`Name[${name}]is blocked`, 400)
        }
    } catch (error) {
        console.error(error);
    }
    try {
        const addressPrefix = await getAddressPrefix(c);
        const sourceMeta = c.req.header('CF-Connecting-IP')
            || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim()
            || c.req.header('X-Real-IP')
            || 'web:unknown';
        const res = await newAddress(c, {
            name, domain,
            enablePrefix: true,
            enableRandomSubdomain: getBooleanValue(enableRandomSubdomain),
            checkLengthByConfig: true,
            addressPrefix,
            sourceMeta
        });
        return c.json(res);
    } catch (e) {
        return c.text(`${msgs.FailedCreateAddressMsg}: ${(e as Error).message}`, 400)
    }
};

export default { createNewAddress };
