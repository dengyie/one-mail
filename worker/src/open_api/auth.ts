import { Hono } from 'hono'

import utils, { checkCfTurnstile, getPasswords, getAdminPasswords, hashPassword } from '../utils';
import { isAdminLockedOut, recordAdminFailure, clearAdminFailures } from '../unified/admin_lockout';
import { verifyActiveAddressJwt } from '../core/auth';
import i18n from '../i18n';

const api = new Hono<HonoCustomType>()

// 空 / 非 JSON body 容错：c.req.json() 对空 body 抛 SyntaxError(Unexpected end of JSON input)，
// 裸调用会让 /open_api/*_login 在探测者发空 POST 时返回 500。这里 catch 成 {}，
// 后续各路由的 !password / !credential 判定即走 401（与密码错误同语义，不泄露 body 缺失 vs 密码错）。
const parseLoginBody = async <T>(c: Parameters<Parameters<typeof api.post>[1]>[0]): Promise<T> => {
    try { return await c.req.json<T>(); } catch { return {} as T; }
}

api.post('/open_api/site_login', async (c) => {
    const { password, cf_token } = await parseLoginBody<{ password?: string; cf_token?: string }>(c);
    const msgs = i18n.getMessagesbyContext(c);
    if (utils.isGlobalTurnstileEnabled(c)) {
        try {
            await checkCfTurnstile(c, cf_token);
        } catch (error) {
            return c.text(msgs.TurnstileCheckFailedMsg, 400)
        }
    }
    const passwords = getPasswords(c);
    const hashedPasswords = await Promise.all(passwords.map(p => hashPassword(p)));
    if (!hashedPasswords.length || !password || !hashedPasswords.includes(password)) {
        return c.text(msgs.CustomAuthPasswordMsg, 401)
    }
    return c.json({ success: true })
})

api.post('/open_api/admin_login', async (c) => {
    const { password, cf_token } = await parseLoginBody<{ password?: string; cf_token?: string }>(c);
    const msgs = i18n.getMessagesbyContext(c);
    if (utils.isGlobalTurnstileEnabled(c)) {
        try {
            await checkCfTurnstile(c, cf_token);
        } catch (error) {
            return c.text(msgs.TurnstileCheckFailedMsg, 400)
        }
    }
    // I7c admin 登录失败锁定（按 IP 计数，15min 窗口 ≥10 次失败锁定）。KV 不可达时
    // fail-closed（isAdminLockedOut 返回 true 直接拒）——宁可暂拒合法 admin 也别放行爆破。
    if (await isAdminLockedOut(c)) {
        return c.text(msgs.RateLimitExceededMsg, 429)
    }
    const adminPasswords = getAdminPasswords(c);
    const hashedPasswords = await Promise.all(adminPasswords.map(p => hashPassword(p)));
    if (!hashedPasswords.length || !password || !hashedPasswords.includes(password)) {
        // 密码不匹配：记一次失败（触发锁定后 15min 内拒登）。KV 挂时 recordAdminFailure
        // 返回 -1，登录仍以 401 拒绝（fail-closed 语义，不影响错误判定）。
        await recordAdminFailure(c);
        return c.text(msgs.NeedAdminPasswordMsg, 401)
    }
    // 登录成功：清空本 IP 窗口内的失败计数
    await clearAdminFailures(c);
    return c.json({ success: true })
})

api.post('/open_api/credential_login', async (c) => {
    const { credential, cf_token } = await parseLoginBody<{ credential?: string; cf_token?: string }>(c);
    const msgs = i18n.getMessagesbyContext(c);
    if (utils.isGlobalTurnstileEnabled(c)) {
        try {
            await checkCfTurnstile(c, cf_token);
        } catch (error) {
            return c.text(msgs.TurnstileCheckFailedMsg, 400)
        }
    }
    if (!credential) {
        return c.text(msgs.InvalidAddressCredentialMsg, 401)
    }
    // 地址凭据同时校验签名、过期时间和当前 address id/name 绑定，删除或替换地址后立即失效。
    // 其余 Jwt.verify 残留（user/telegram/config 类）非地址 JWT，不在本次范围。
    const payload = await verifyActiveAddressJwt(c, credential);
    if (!payload || !payload.address) {
        return c.text(msgs.InvalidAddressCredentialMsg, 401)
    }
    return c.json({ success: true })
})

export { api }
