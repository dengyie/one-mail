import { Context } from "hono";
import { CONSTANTS } from "../constants";
import { AdminWebhookSettings } from "../models";

async function getWebhookSettings(c: Context<HonoCustomType>): Promise<Response> {
    const settings = await c.env.KV.get<AdminWebhookSettings>(CONSTANTS.WEBHOOK_KV_SETTINGS_KEY, "json");
    return c.json(settings || new AdminWebhookSettings(false, []));
}

async function saveWebhookSettings(c: Context<HonoCustomType>): Promise<Response> {
    const settings = await c.req.json<AdminWebhookSettings>();
    // I7d：webhook 设置里可配 URL 的字段在 AddressCreation/WebhookSettings 存储
    // （这里是全局 allow-list 配置，本身不含 URL，跳过 URL 校验）。真正存 URL 的
    // save 端点在 mail_webhook_settings.ts / mails_api/webhook_settings.ts 校验。
    await c.env.KV.put(CONSTANTS.WEBHOOK_KV_SETTINGS_KEY, JSON.stringify(settings));
    return c.json({ success: true })
}

export default {
    getWebhookSettings,
    saveWebhookSettings,
}
