import { Context } from 'hono';
import { Jwt } from 'hono/utils/jwt'

import i18n from '../i18n';
import utils, { checkCfTurnstile, getJsonSetting, checkUserPassword, getUserRoles, getStringValue, getMailDomain, includesDomain, checkRegistrationRateLimit } from "../utils"
import { CONSTANTS } from "../constants";
import { GeoData, UserInfo, UserSettings } from "../models";
import { sendMail } from "../mails_api/send_mail_api";
import { hashPasswordForStorage, verifyPassword } from "../core/password.ts";
import {
    consumeRegistrationVerifyCode,
    generateRegistrationVerifyCode,
    reserveRegistrationVerifyCode,
} from "./registration_verify_code";

export default {
    verifyCode: async (c: Context<HonoCustomType>) => {
        const { email, cf_token } = await c.req.json();
        const msgs = i18n.getMessagesbyContext(c);
        // KV rate limit: 5 verify_code attempts / IP / 60s
        if (!(await checkRegistrationRateLimit(c, "verify_code", 5, 60))) {
            return c.text(msgs.RateLimitExceededMsg || "Too many requests, please try later", 429);
        }
        // check cf turnstile
        try {
            await checkCfTurnstile(c, cf_token);
        } catch (error) {
            return c.text(msgs.TurnstileCheckFailedMsg, 400)
        }
        const value = await getJsonSetting(c, CONSTANTS.USER_SETTINGS_KEY);
        const settings = new UserSettings(value)
        // check mail domain allow list
        const mailDomain = getMailDomain(email);
        if (settings.enableMailAllowList
            && settings.mailAllowList
            && !includesDomain(settings.mailAllowList, mailDomain)
        ) {
            return c.text(`${msgs.UserMailDomainMustInMsg} ${JSON.stringify(settings.mailAllowList, null, 2)}`, 400)
        }
        // check email regex
        if (settings.enableEmailCheckRegex && settings.emailCheckRegex) {
            try {
                const regex = new RegExp(settings.emailCheckRegex);
                if (!regex.test(email)) {
                    return c.text(`${msgs.UserEmailNotMatchRegexMsg}: /${settings.emailCheckRegex}/`, 400)
                }
            } catch (e) {
                console.error("Failed to check user email regex", e);
            }
        }
        if (!settings.verifyMailSender) {
            return c.text(msgs.VerifyMailSenderNotSetMsg, 400)
        }

        const code = generateRegistrationVerifyCode();
        const reservation = await reserveRegistrationVerifyCode(
            c.env.DB,
            c.env.JWT_SECRET,
            email as string,
            code,
        );
        if (reservation === "active") {
            return c.text(msgs.CodeAlreadySentMsg, 400)
        }
        if (reservation === "error") {
            return c.text(msgs.OperationFailedMsg, 500)
        }

        try {
            await sendMail(c, settings.verifyMailSender, {
                from_name: "Temp Mail Verify",
                to_name: '',
                to_mail: email as string,
                subject: "Temp Mail Verify code",
                content: `Your verify code is ${code}`,
                is_html: false,
            })
        } catch (e) {
            // Keep the reserved code until TTL even on send errors: a provider
            // timeout can mean the message was accepted but the outcome is
            // unknown. Deleting here would make a later-delivered code unusable.
            return c.text(`Failed to send verify code: ${(e as Error).message}`, 500)
        }
        return c.json({
            success: true,
            expirationTtl: 300
        })
    },
    register: async (c: Context<HonoCustomType>) => {
        const value = await getJsonSetting(c, CONSTANTS.USER_SETTINGS_KEY);
        const settings = new UserSettings(value)
        const msgs = i18n.getMessagesbyContext(c);
        // check enable
        if (!settings.enable) {
            return c.text(msgs.UserRegistrationDisabledMsg, 403);
        }
        // KV rate limit: 5 register attempts / IP / 60s
        if (!(await checkRegistrationRateLimit(c, "register", 5, 60))) {
            return c.text(msgs.RateLimitExceededMsg || "Too many requests, please try later", 429);
        }
        // check request
        const { email, password, code, cf_token } = await c.req.json();
        if (!email || !password) {
            return c.text(msgs.InvalidEmailOrPasswordMsg, 400)
        }
        checkUserPassword(password);
        // check cf turnstile only when mail verify is disabled
        // (when enabled, verify_code endpoint already checks turnstile)
        if (!settings.enableMailVerify) {
            try {
                await checkCfTurnstile(c, cf_token);
            } catch (error) {
                return c.text(msgs.TurnstileCheckFailedMsg, 400)
            }
        }
        if (settings.enableMailVerify && !code) {
            return c.text(msgs.InvalidVerifyCodeMsg, 400)
        }
        // check mail domain allow list
        const mailDomain = getMailDomain(email);
        if (settings.enableMailAllowList
            && settings.mailAllowList
            && !includesDomain(settings.mailAllowList, mailDomain)
        ) {
            return c.text(`${msgs.UserMailDomainMustInMsg} ${JSON.stringify(settings.mailAllowList, null, 2)}`, 400)
        }
        // check email regex
        if (settings.enableEmailCheckRegex && settings.emailCheckRegex) {
            try {
                const regex = new RegExp(settings.emailCheckRegex);
                if (!regex.test(email)) {
                    return c.text(`${msgs.UserEmailNotMatchRegexMsg}: /${settings.emailCheckRegex}/`, 400)
                }
            } catch (e) {
                console.error("Failed to check user email regex", e);
            }
        }
        // check and consume code exactly once
        if (settings.enableMailVerify) {
            const verification = await consumeRegistrationVerifyCode(
                c.env.DB,
                c.env.JWT_SECRET,
                email as string,
                String(code),
            );
            if (verification === "error") {
                return c.text(msgs.OperationFailedMsg, 500)
            }
            if (verification !== "consumed") {
                return c.text(msgs.InvalidVerifyCodeMsg, 400)
            }
        }
        const storedPassword = await hashPasswordForStorage(password);
        // geo data
        const reqIp = c.req.raw.headers.get("cf-connecting-ip")
        const geoData = new GeoData(reqIp, c.req.raw.cf as any);
        const userInfo = new UserInfo(geoData, email);
        // if not enable mail verify, do not on conflict update
        if (!settings.enableMailVerify) {
            try {
                const { success } = await c.env.DB.prepare(
                    `INSERT INTO users (user_email, password, user_info)`
                    + ` VALUES (?, ?, ?)`
                ).bind(
                    email, storedPassword, JSON.stringify(userInfo)
                ).run();
                if (!success) {
                    return c.text(msgs.FailedToRegisterMsg, 500)
                }
            } catch (e) {
                const error = e as Error;
                if (error.message && error.message.includes("UNIQUE")) {
                    return c.text(msgs.UserAlreadyExistsMsg, 400)
                }
                return c.text(`${msgs.FailedToRegisterMsg}: ${error.message}`, 500)
            }
            return c.json({ success: true })
        }
        // if enable mail verify, on conflict update
        const { success } = await c.env.DB.prepare(
            `INSERT INTO users (user_email, password, user_info)`
            + ` VALUES (?, ?, ?)`
            + ` ON CONFLICT(user_email) DO UPDATE SET password = ?, user_info = ?, updated_at = datetime('now')`
        ).bind(
            email, storedPassword, JSON.stringify(userInfo),
            storedPassword, JSON.stringify(userInfo)
        ).run();
        if (!success) {
            return c.text(msgs.FailedToRegisterMsg, 400);
        }
        const defaultRole = getStringValue(c.env.USER_DEFAULT_ROLE);
        if (!defaultRole) return c.json({ success: true })
        const user_roles = getUserRoles(c);
        if (!user_roles.find((r) => r.role === defaultRole)) {
            return c.text(msgs.InvalidUserDefaultRoleMsg, 500);
        }
        // find user_id
        const user_id = await c.env.DB.prepare(
            `SELECT id FROM users where user_email = ?`
        ).bind(email).first<number | undefined | null>("id");
        if (!user_id) {
            return c.text(msgs.UserNotFoundMsg, 500);
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
        return c.json({ success: true })
    },
    login: async (c: Context<HonoCustomType>) => {
        const { email, password, cf_token } = await c.req.json();
        const msgs = i18n.getMessagesbyContext(c);
        if (!email || !password) return c.text(msgs.InvalidEmailOrPasswordMsg, 400);
        // check cf turnstile if global turnstile is enabled
        if (utils.isGlobalTurnstileEnabled(c)) {
            try {
                await checkCfTurnstile(c, cf_token);
            } catch (error) {
                return c.text(msgs.TurnstileCheckFailedMsg, 400)
            }
        }
        const record = await c.env.DB.prepare(
            `SELECT id, password FROM users where user_email = ?`
        ).bind(email).first<{ id: number; password: string }>();
        const user_id = record?.id;
        const dbPassword = record?.password;
        if (typeof dbPassword !== "string") {
            return c.text(msgs.UserNotFoundMsg, 400)
        }
        const verification = await verifyPassword(password, dbPassword);
        if (!verification.valid) {
            return c.text(msgs.InvalidEmailOrPasswordMsg, 400)
        }
        if (verification.needsRehash && user_id !== undefined) {
            try {
                const upgradedPassword = await hashPasswordForStorage(password);
                await c.env.DB.prepare(
                    `UPDATE users SET password = ? WHERE id = ? AND password = ?`
                ).bind(upgradedPassword, user_id, dbPassword).run();
            } catch (error) {
                console.warn("[user-login] password upgrade failed:", error);
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
    },
}
