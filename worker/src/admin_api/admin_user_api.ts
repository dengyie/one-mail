import { Context } from 'hono';

import { CONSTANTS } from '../constants';
import { getJsonSetting, saveSetting, checkUserPassword, getDomains, getUserRoles, getMailDomain, includesDomain } from '../utils';
import { UserSettings, GeoData, UserInfo, RoleAddressConfig } from "../models";
import { handleListQuery } from '../common'
import UserBindAddressModule from '../user_api/bind_address';
import i18n from '../i18n';
import { mergeRoleAddressConfigs } from "../unified/rbac_config";
import { hashPasswordForStorage } from "../core/password.ts";
import { DEFAULT_MAX_ADDRESS_COUNT, HARD_MAX_UNIFIED_PAGE_SIZE } from "../quota.ts";

export default {
    getSetting: async (c: Context<HonoCustomType>) => {
        const value = await getJsonSetting(c, CONSTANTS.USER_SETTINGS_KEY);
        const settings = new UserSettings(value);
        return c.json(settings)
    },
    saveSetting: async (c: Context<HonoCustomType>) => {
        const msgs = i18n.getMessagesbyContext(c);
        const value = await c.req.json();
        const settings = new UserSettings(value);
        if (settings.enableMailVerify && !c.env.KV) {
            return c.text(msgs.EnableKVForMailVerifyMsg, 403)
        }
        if (settings.enableMailVerify && !settings.verifyMailSender) {
            return c.text(msgs.VerifyMailSenderNotSetMsg, 400)
        }
        if (settings.enableMailVerify && settings.verifyMailSender) {
            const mailDomain = getMailDomain(settings.verifyMailSender);
            const domains = getDomains(c);
            if (!includesDomain(domains, mailDomain)) {
                return c.text(`${msgs.VerifyMailDomainInvalidMsg} ${JSON.stringify(domains, null, 2)}`, 400)
            }
        }
        // Legacy 0 used to mean unlimited. Non-admin users must now always have a
        // finite quota, so normalize legacy/invalid values to the finite default.
        if (!Number.isInteger(settings.maxAddressCount) || settings.maxAddressCount < 1) {
            settings.maxAddressCount = DEFAULT_MAX_ADDRESS_COUNT;
        }
        await saveSetting(c, CONSTANTS.USER_SETTINGS_KEY, JSON.stringify(settings));
        return c.json({ success: true })
    },
    getUsers: async (c: Context<HonoCustomType>) => {
        const { limit, offset, query } = c.req.query();
        if (query) {
            // D1 caps LIKE pattern length at 50 bytes; fall back to instr()
            // for longer queries to avoid "LIKE or GLOB pattern too complex" (#956).
            const useInstr = new TextEncoder().encode(query).length + 2 > 50;
            const param = useInstr ? query : `%${query}%`;
            const userEmailWhere = useInstr ? `instr(u.user_email, ?) > 0` : `u.user_email like ?`;
            const userEmailWhereCount = useInstr ? `instr(user_email, ?) > 0` : `user_email like ?`;
            return await handleListQuery(c,
                `SELECT u.id as id, u.user_email, u.created_at, u.updated_at,`
                + ` ur.role_text as role_text,`
                + ` (SELECT COUNT(*) FROM users_address WHERE user_id = u.id) AS address_count`
                + ` FROM users u`
                + ` LEFT JOIN user_roles ur ON u.id = ur.user_id`
                + ` where ${userEmailWhere}`,
                `SELECT count(*) as count FROM users where ${userEmailWhereCount}`,
                [param], limit, offset
            );
        }
        return await handleListQuery(c,
            `SELECT u.id as id, u.user_email, u.created_at, u.updated_at,`
            + ` ur.role_text as role_text,`
            + ` (SELECT COUNT(*) FROM users_address WHERE user_id = u.id) AS address_count`
            + ` FROM users u`
            + ` LEFT JOIN user_roles ur ON u.id = ur.user_id`,
            `SELECT count(*) as count FROM users`,
            [], limit, offset
        );
    },
    createUser: async (c: Context<HonoCustomType>) => {
        const msgs = i18n.getMessagesbyContext(c);
        const { email, password } = await c.req.json();
        if (!email || !password) {
            return c.text(msgs.InvalidEmailOrPasswordMsg, 400)
        }
        // geo data
        const reqIp = c.req.raw.headers.get("cf-connecting-ip")
        const geoData = new GeoData(reqIp, c.req.raw.cf as any);
        const userInfo = new UserInfo(geoData, email);
        try {
            checkUserPassword(password);
            const storedPassword = await hashPasswordForStorage(password);
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
            const errorMsg = (e as Error).message;
            if (errorMsg && errorMsg.includes("UNIQUE")) {
                return c.text(msgs.UserAlreadyExistsMsg, 400)
            }
            return c.text(`${msgs.FailedToRegisterMsg}: ${errorMsg}`, 500)
        }
        return c.json({ success: true })
    },
    deleteUser: async (c: Context<HonoCustomType>) => {
        const { user_id } = c.req.param();
        const msgs = i18n.getMessagesbyContext(c);
        if (!user_id) return c.text(msgs.UserNotFoundMsg, 400);
        const existing = await c.env.DB.prepare(
            `SELECT id FROM users WHERE id = ?`
        ).bind(user_id).first("id");
        if (existing === undefined || existing === null) {
            return c.text(msgs.UserNotFoundMsg, 404);
        }
        // All user-owned rows are removed in one D1 transaction. The address
        // rows themselves are intentionally retained: they are global mailbox
        // records and may contain mail history; users_address is the ownership
        // link that must be removed before the user row.
        try {
            const results = await c.env.DB.batch([
                c.env.DB.prepare(
                    `DELETE FROM user_passkeys WHERE user_id = ?`
                ).bind(user_id),
                // Imported mail is scoped by to_addr at read time. Remove it before
                // dropping the account rows so a later user cannot reclaim the same
                // external username and see the deleted user's history.
                c.env.DB.prepare(
                    `DELETE FROM emails
                     WHERE account_id IN (
                         SELECT id FROM user_mail_accounts WHERE user_id = ?
                     )`
                ).bind(user_id),
                c.env.DB.prepare(
                    `DELETE FROM user_mail_accounts WHERE user_id = ?`
                ).bind(user_id),
                c.env.DB.prepare(
                    `DELETE FROM user_roles WHERE user_id = ?`
                ).bind(user_id),
                c.env.DB.prepare(
                    `DELETE FROM users_address WHERE user_id = ?`
                ).bind(user_id),
                c.env.DB.prepare(
                    `DELETE FROM users WHERE id = ?`
                ).bind(user_id),
            ]);
            if (!results.every((result) => result.success)) {
                return c.text(msgs.FailedDeleteUserMsg, 500);
            }
        } catch (error) {
            console.error("[admin-delete-user] transaction failed:", error);
            return c.text(msgs.FailedDeleteUserMsg, 500);
        }
        return c.json({ success: true })
    },
    resetPassword: async (c: Context<HonoCustomType>) => {
        const { user_id } = c.req.param();
        const { password } = await c.req.json();
        const msgs = i18n.getMessagesbyContext(c);
        if (!user_id) return c.text(msgs.UserNotFoundMsg, 400);
        try {
            checkUserPassword(password);
            const storedPassword = await hashPasswordForStorage(password);
            const { success } = await c.env.DB.prepare(
                `UPDATE users SET password = ? WHERE id = ?`
            ).bind(storedPassword, user_id).run();
            if (!success) {
                return c.text(msgs.FailedUpdatePasswordMsg, 500)
            }
        } catch (e) {
            return c.text(`${msgs.FailedUpdatePasswordMsg}: ${(e as Error).message}`, 500)
        }
        return c.json({ success: true });
    },
    updateUserRoles: async (c: Context<HonoCustomType>) => {
        const msgs = i18n.getMessagesbyContext(c);
        const { user_id, role_text } = await c.req.json();
        if (!user_id) return c.text(msgs.InvalidUserIdMsg, 400);
        if (!role_text) {
            const { success } = await c.env.DB.prepare(
                `DELETE FROM user_roles WHERE user_id = ?`
            ).bind(user_id).run();
            if (!success) {
                return c.text(msgs.FailedUpdateUserDefaultRoleMsg, 500)
            }
            return c.json({ success: true })
        }
        const user_roles = getUserRoles(c);
        if (!user_roles.find((r) => r.role === role_text)) {
            return c.text(msgs.InvalidRoleTextMsg, 400)
        }
        const { success } = await c.env.DB.prepare(
            `INSERT INTO user_roles (user_id, role_text)`
            + ` VALUES (?, ?)`
            + ` ON CONFLICT(user_id) DO UPDATE SET role_text = ?, updated_at = datetime('now')`
        ).bind(user_id, role_text, role_text).run();
        if (!success) {
            return c.text(msgs.FailedUpdateUserDefaultRoleMsg, 500)
        }
        return c.json({ success: true })
    },
    bindAddress: async (c: Context<HonoCustomType>) => {
        const {
            user_email, address, user_id, address_id
        } = await c.req.json();
        const db_user_id = user_id ?? await c.env.DB.prepare(
            `SELECT id FROM users WHERE user_email = ?`
        ).bind(user_email).first<number | undefined | null>("id");
        const db_address_id = address_id ?? await c.env.DB.prepare(
            `SELECT id FROM address WHERE name = ?`
        ).bind(address).first<number | undefined | null>("id");
        return await UserBindAddressModule.bindByID(c, db_user_id, db_address_id);
    },
    getBindedAddresses: async (c: Context<HonoCustomType>) => {
        const { user_id } = c.req.param();
        const results = await UserBindAddressModule.getBindedAddressesById(c, user_id);
        return c.json({
            results: results,
        });
    },
    getRoleAddressConfig: async (c: Context<HonoCustomType>) => {
        const value = await getJsonSetting<RoleAddressConfig>(c, CONSTANTS.ROLE_ADDRESS_CONFIG_KEY);
        const configs = value || {};
        return c.json({ configs });
    },
    saveRoleAddressConfig: async (c: Context<HonoCustomType>) => {
        const msgs = i18n.getMessagesbyContext(c);
        const { configs } = await c.req.json<{ configs: RoleAddressConfig }>();
        if (typeof configs !== "object" || configs === null || Array.isArray(configs)) {
            return c.text(msgs.InvalidMaxAddressCountMsg, 400);
        }
        for (const config of Object.values(configs)) {
            if (config?.maxAddressCount !== undefined
                && (!Number.isInteger(config.maxAddressCount) || config.maxAddressCount < 1)) {
                return c.text(msgs.InvalidMaxAddressCountMsg, 400);
            }
            if (config?.maxMailAccountCount !== undefined
                && (!Number.isInteger(config.maxMailAccountCount) || config.maxMailAccountCount < 1)) {
                return c.text(msgs.InvalidMaxAddressCountMsg, 400);
            }
            // Unified Inbox 单页配额必须始终保留 Worker 硬上限；0 不能表达 unlimited。
            if (config?.maxUnifiedPageSize !== undefined
                && (!Number.isInteger(config.maxUnifiedPageSize)
                    || config.maxUnifiedPageSize < 1
                    || config.maxUnifiedPageSize > HARD_MAX_UNIFIED_PAGE_SIZE)) {
                return c.text(msgs.InvalidMaxAddressCountMsg, 400);
            }
        }
        // C2 [安全]: 改 merge（PATCH 语义）而非整表替换，避免两 admin 并发配不同 role 互覆盖。
        // incoming 中提交的 role 键覆盖既有同名 role 对象；未提交的 role 保留原值。
        const existing = await getJsonSetting<RoleAddressConfig>(c, CONSTANTS.ROLE_ADDRESS_CONFIG_KEY);
        const merged = mergeRoleAddressConfigs(existing, configs);
        await saveSetting(c, CONSTANTS.ROLE_ADDRESS_CONFIG_KEY, JSON.stringify(merged));
        return c.json({ success: true });
    },
}
