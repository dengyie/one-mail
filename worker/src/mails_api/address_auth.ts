import { Context } from 'hono';
import i18n from '../i18n';
import utils, { getBooleanValue, checkCfTurnstile } from '../utils';
import { hashPasswordForStorage, verifyPassword } from '../core/password.ts';
import { signAddressJwt } from '../core/auth';

export default {
    // 修改地址密码
    changePassword: async (c: Context<HonoCustomType>) => {
        const { new_password } = await c.req.json();
        const msgs = i18n.getMessagesbyContext(c);
        const { address, address_id } = c.get("jwtPayload");

        // 检查功能是否启用
        if (!getBooleanValue(c.env.ENABLE_ADDRESS_PASSWORD)) {
            return c.text(msgs.PasswordChangeDisabledMsg, 403);
        }

        if (typeof new_password !== "string" || new_password.length < 1 || new_password.length > 100) {
            return c.text(msgs.NewPasswordRequiredMsg, 400);
        }

        if (!address || !address_id) {
            return c.text(msgs.InvalidAddressTokenMsg, 400);
        }

        const storedPassword = await hashPasswordForStorage(new_password);
        const { success } = await c.env.DB.prepare(
            `UPDATE address SET password = ?, updated_at = datetime('now') WHERE id = ?`
        ).bind(storedPassword, address_id).run();

        if (!success) {
            return c.text(msgs.FailedUpdatePasswordMsg, 500);
        }

        return c.json({ success: true });
    },

    // 地址密码登录
    login: async (c: Context<HonoCustomType>) => {
        const { email, password, cf_token } = await c.req.json();
        const msgs = i18n.getMessagesbyContext(c);

        // 检查功能是否启用
        if (!getBooleanValue(c.env.ENABLE_ADDRESS_PASSWORD)) {
            return c.text(msgs.PasswordLoginDisabledMsg, 403);
        }

        if (!email || !password) {
            return c.text(msgs.EmailPasswordRequiredMsg, 400);
        }

        // check cf turnstile if global turnstile is enabled
        if (utils.isGlobalTurnstileEnabled(c)) {
            try {
                await checkCfTurnstile(c, cf_token);
            } catch (error) {
                return c.text(msgs.TurnstileCheckFailedMsg, 400)
            }
        }

        // 查找地址
        const address = await c.env.DB.prepare(
            `SELECT * FROM address WHERE name = ?`
        ).bind(email).first();

        if (!address) {
            return c.text(msgs.AddressNotFoundMsg, 404);
        }

        const verification = await verifyPassword(password, String(address.password ?? ""));
        if (!verification.valid) {
            return c.text(msgs.InvalidEmailOrPasswordMsg, 401);
        }
        if (verification.needsRehash) {
            try {
                const upgradedPassword = await hashPasswordForStorage(password);
                await c.env.DB.prepare(
                    `UPDATE address SET password = ? WHERE id = ? AND password = ?`
                ).bind(upgradedPassword, address.id, address.password).run();
            } catch (error) {
                console.warn("[address-login] password upgrade failed:", error);
            }
        }

        // 创建JWT
        const jwt = await signAddressJwt(c, {
            address: address.name,
            address_id: address.id,
        });

        return c.json({
            jwt: jwt,
            address: address.name
        });
    }
};
