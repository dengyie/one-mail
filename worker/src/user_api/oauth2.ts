import { Context } from 'hono';
import { Jwt } from 'hono/utils/jwt'

import i18n from '../i18n';
import { getJsonSetting, getMailDomain, getStringValue, getUserRoles, includesDomain } from '../utils';
import { UserOauth2Settings } from '../models';
import { CONSTANTS } from '../constants';
import { storeOAuthState, verifyOAuthState, resolveOAuthState } from '../unified/oauth_state';


export default {
    getOauth2LoginUrl: async (c: Context<HonoCustomType>) => {
        const settings = await getJsonSetting<UserOauth2Settings[]>(c, CONSTANTS.OAUTH2_SETTINGS_KEY);
        const { clientID } = c.req.query();
        const msgs = i18n.getMessagesbyContext(c);
        const setting = settings?.find(s => s.clientID === clientID);
        if (!setting) {
            return c.text(msgs.Oauth2ClientIDNotFoundMsg, 400);
        }
        // Generate state server-side so callers cannot choose or reuse a predictable value.
        // Store it before redirecting; callback verification remains fail-closed when KV is unavailable.
        const state = crypto.randomUUID();
        if (!(await storeOAuthState(c, state, clientID))) {
            return c.text(msgs.Oauth2CliendIDOrCodeMissingMsg, 400);
        }
        const url = `${setting.authorizationURL}?client_id=${setting.clientID}&response_type=code&redirect_uri=${setting.redirectURL}&scope=${setting.scope}&state=${state}`
        return c.json({ url, state });
    },
    oauth2Login: async (c: Context<HonoCustomType>) => {
        const body = await c.req.json<{ clientID?: string, code?: string, state?: string }>();
        const { clientID, code } = body;
        const msgs = i18n.getMessagesbyContext(c);
        if (!clientID || !code) {
            return c.text(msgs.Oauth2CliendIDOrCodeMissingMsg, 400);
        }
        // R3（CRITICAL）: OAuth callback 无条件 require state（fail-closed 防
        // CSRF 换 code）。原实现在 state 缺失时跳过校验（向后兼容窗口），攻击者可
        // 携带他人 code 而不带 state 直接换 code。现无 state/state 不匹配/
        // 过期/clientID 不匹配一律 400 拒绝；state 由 getOauth2LoginUrl 写入 KV
        // （10min TTL，一次性消费）。前端 UserOauth2Callback.vue 已同步：callback
        // body 固定携带 `state`（route.query.state || sessionStorage 存储的 state）。
        // 旧前端在升级前因不发 state 会被拒绝（新 worker 是权威，fail-closed）。
        const state = resolveOAuthState(body.state, c.req.query("state"));
        if (!state) {
            return c.text(msgs.Oauth2CliendIDOrCodeMissingMsg, 400);
        }
        const valid = await verifyOAuthState(c, state, clientID);
        if (!valid) {
            return c.text(msgs.Oauth2CliendIDOrCodeMissingMsg, 400);
        }
        const settings = await getJsonSetting<UserOauth2Settings[]>(c, CONSTANTS.OAUTH2_SETTINGS_KEY);
        const setting = settings?.find(s => s.clientID === clientID);
        if (!setting) {
            return c.text(msgs.Oauth2ClientIDNotFoundMsg, 400);
        }
        const params = {
            code,
            client_id: setting.clientID,
            client_secret: setting.clientSecret,
            grant_type: 'authorization_code',
            redirect_uri: setting.redirectURL,
        }
        const res = await fetch(setting.accessTokenURL, {
            method: 'POST',
            body: setting.accessTokenFormat === 'json'
                ? JSON.stringify(params) :
                new URLSearchParams(params).toString(),
            headers: {
                'Content-Type': setting.accessTokenFormat === 'json'
                    ? 'application/json'
                    : 'application/x-www-form-urlencoded',
                "Accept": "application/json"
            }
        })
        if (!res.ok) {
            console.error(`Failed to get access token: ${res.status} ${res.statusText} ${await res.text()}`)
            return c.text(msgs.Oauth2FailedGetAccessTokenMsg, 400);
        }
        const resJson = await res.json();
        const { access_token, token_type } = resJson as { access_token: string, token_type?: string };
        const userRes = await fetch(setting.userInfoURL, {
            headers: {
                "Authorization": `${token_type || 'Bearer'} ${access_token}`,
                "Accept": "application/json",
                "User-Agent": "Cloudflare Workers"
            }
        })
        if (!userRes.ok) {
            console.error(`Failed to get user info: ${userRes.status} ${userRes.statusText} ${await userRes.text()}`)
            return c.text(msgs.Oauth2FailedGetUserInfoMsg, 400);
        }
        const userInfo = await userRes.json<any>()

        const rawEmail = await (async () => {
            if (setting.userEmailKey.startsWith("$")) {
                const { JSONPath } = await import('jsonpath-plus');
                const email = JSONPath({
                    path: setting.userEmailKey,
                    json: userInfo,
                })
                if (email && Array.isArray(email) && email.length > 0) {
                    return email[0];
                }
            }
            const { [setting.userEmailKey]: email } = userInfo as { [key: string]: string };
            return email;
        })()

        if (!rawEmail) {
            return c.text(msgs.Oauth2FailedGetUserEmailMsg, 400);
        }

        // Apply email format transformation if enabled
        const email = (() => {
            const rawEmailStr = String(rawEmail).slice(0, 256).trim();  // 限制长度防止 ReDoS
            if (!setting.enableEmailFormat || !setting.userEmailFormat) {
                return rawEmailStr;
            }
            try {
                const regex = new RegExp(setting.userEmailFormat);
                const replacement = setting.userEmailReplace || '$1';
                return rawEmailStr.replace(regex, replacement).trim();
            } catch (e) {
                console.error(`Invalid regex in userEmailFormat: ${setting.userEmailFormat}`, e);
                return rawEmailStr;
            }
        })();

        if (!email) {
            return c.text(msgs.Oauth2FailedGetUserEmailMsg, 400);
        }
        // check email in mail allow list
        const mailDomain = getMailDomain(email);
        if (setting.enableMailAllowList && !includesDomain(setting.mailAllowList, mailDomain)) {
            return c.text(`${msgs.UserMailDomainMustInMsg} ${JSON.stringify(setting.mailAllowList, null, 2)}`, 400)
        }
        // insert or update user
        const { success } = await c.env.DB.prepare(
            `INSERT INTO users (user_email, password, user_info)`
            + ` VALUES (?, '', ?)`
            + ` ON CONFLICT(user_email) DO UPDATE SET updated_at = datetime('now')`
        ).bind(
            email, JSON.stringify(userInfo)
        ).run();
        if (!success) {
            return c.text(msgs.FailedToRegisterMsg, 500)
        }
        const { id: user_id } = await c.env.DB.prepare(
            `SELECT id FROM users where user_email = ?`
        ).bind(email).first() || {};
        if (!user_id) {
            return c.text(msgs.UserNotFoundMsg, 400)
        }
        // process user roles
        const defaultRole = getStringValue(c.env.USER_DEFAULT_ROLE);
        if (defaultRole) {
            const user_roles = getUserRoles(c);
            if (!user_roles.find((r) => r.role === defaultRole)) {
                return c.text(msgs.InvalidUserDefaultRoleMsg, 500);
            }
            // update user roles
            const { success: success2 } = await c.env.DB.prepare(
                `INSERT INTO user_roles (user_id, role_text)`
                + ` VALUES (?, ?)`
                + ` ON CONFLICT(user_id) DO NOTHING`
            ).bind(user_id, defaultRole).run();
            if (!success2) {
                return c.text(msgs.FailedUpdateUserDefaultRoleMsg, 500);
            }
        }
        // create jwt
        const jwt = await Jwt.sign({
            user_email: email,
            user_id: user_id,
            // 90 days expire in seconds
            exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
            iat: Math.floor(Date.now() / 1000),
        }, c.env.JWT_SECRET, "HS256")
        return c.json({
            jwt: jwt
        })
    }
}
