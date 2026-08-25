import { Hono } from 'hono'
import { ServerResponse } from 'node:http'
import { Writable } from 'node:stream'

import { newTelegramBot, initTelegramBotCommands, sendMailToTelegram } from './telegram'
import settings from './settings'
import miniapp from './miniapp'
import i18n from '../i18n'
import { safeEqual } from '../core/timing'

export const api = new Hono<HonoCustomType>();
export { sendMailToTelegram }

api.use("/telegram/*", async (c, next) => {
    const msgs = i18n.getMessagesbyContext(c);
    if (!c.env.TELEGRAM_BOT_TOKEN) {
        return c.text(msgs.TgBotTokenRequiredMsg, 400);
    }
    if (!c.env.KV) {
        return c.text(msgs.KVNotAvailableMsg, 400);
    }
    return await next();
});

api.use("/admin/telegram/*", async (c, next) => {
    const msgs = i18n.getMessagesbyContext(c);
    if (!c.env.TELEGRAM_BOT_TOKEN) {
        return c.text(msgs.TgBotTokenRequiredMsg, 400);
    }
    if (!c.env.KV) {
        return c.text(msgs.KVNotAvailableMsg, 400);
    }
    return await next();
});

api.post("/telegram/webhook", async (c) => {
    // H4: webhook 来源校验。Telegram Bot API 在 setWebhook 时要求带上
    // secret_token，之后每次回调都会在 X-Telegram-Bot-Api-Secret-Token 头里回传。
    // 若 TELEGRAM_SECRET_TOKEN 已配置，则必须校验该头一致才处理本次更新；
    // 未配置时该端点只记录日志、不回执处理（不执行任何绑定/拉取操作）。
    const secretToken = c.env.TELEGRAM_SECRET_TOKEN;
    if (secretToken) {
        const headerToken = c.req.header("x-telegram-bot-api-secret-token");
        const verified = headerToken !== undefined && headerToken !== null
            && (await safeEqual(secretToken, headerToken));
        if (!verified) {
            console.warn("telegram webhook rejected: X-Telegram-Bot-Api-Secret-Token mismatch");
            return c.text("Unauthorized", 401);
        }
    } else {
        // H2：未配置 secret → 回传 503（非静默 200），使 operator 能察觉 bot 断开。
        // 此前这里无条件 200 + 日志；当 setWebhook 因 TELEGRAM_SECRET_TOKEN 存在而
        // 必须要求 secret 校验时，未配置即等于 bot 回调永远无法通过校验，断送静默。
        console.log("TELEGRAM_SECRET_TOKEN not configured, rejecting webhook (fail-closed)");
        return c.text("Service Unavailable: TELEGRAM_SECRET_TOKEN not configured", 503);
    }
    const token = c.env.TELEGRAM_BOT_TOKEN;
    const bot = newTelegramBot(c, token);
    let body = null;
    const res = new Writable();
    Object.assign(res, {
        headersSent: false,
        setHeader: (name: string, value: string) => c.header(name, value),
        end: (data: any) => body = data,
    });
    const reqJson = await c.req.json();
    await bot.handleUpdate(reqJson, res as ServerResponse);
    return c.body(body);
});

api.post("/admin/telegram/init", async (c) => {
    const domain = new URL(c.req.url).host;
    const token = c.env.TELEGRAM_BOT_TOKEN;
    const webhookUrl = `https://${domain}/telegram/webhook`;
    console.log(`setting webhook to ${webhookUrl}`);
    const bot = newTelegramBot(c, token);
    // H2: setWebhook 必须携带 secret_token（当 TELEGRAM_SECRET_TOKEN 配置时）。
    // Telegram webhook 来源校验依赖 setWebhook 时的 secret_token —— 若不传，
    // 后续每次回调都缺 X-Telegram-Bot-Api-Secret-Token 头 → webhook handler 401
    // 静默断送。仅当 env 存在时附加（未配置的分支不做 setWebhook 变更，
    // 保持开机即用的旧语义：webhook handler 对未配置 secret 返回 503 让
    // operator 察觉）。
    const setWebhookExtra = c.env.TELEGRAM_SECRET_TOKEN
        ? { secret_token: c.env.TELEGRAM_SECRET_TOKEN }
        : {};
    await bot.telegram.setWebhook(webhookUrl, setWebhookExtra)
    await initTelegramBotCommands(c, bot);
    return c.json({
        message: "webhook set successfully",
        secretTokenConfigured: !!c.env.TELEGRAM_SECRET_TOKEN,
    });
});

api.get("/admin/telegram/status", async (c) => {
    const token = c.env.TELEGRAM_BOT_TOKEN;
    const bot = newTelegramBot(c, token);
    const info = await bot.telegram.getWebhookInfo()
    const commands = await bot.telegram.getMyCommands()
    return c.json({ info, commands });
});

api.get("/admin/telegram/settings", settings.getTelegramSettings);
api.post("/admin/telegram/settings", settings.saveTelegramSettings);
api.post("/telegram/get_bind_address", miniapp.getTelegramBindAddress);
api.post("/telegram/new_address", miniapp.newTelegramAddress);
api.post("/telegram/bind_address", miniapp.bindAddress);
api.post("/telegram/unbind_address", miniapp.unbindAddress);
api.post("/telegram/get_mail", miniapp.getMail);
