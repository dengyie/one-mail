import { Context } from "hono";
import { CONSTANTS } from "../constants";
import { AdminWebhookSettings, WebhookSettings, RawMailRow } from "../models";
import { commonParseMail, sendWebhook } from "../common";
import { resolveRawEmail } from "../gzip";
import { isSafeWebhookUrl } from "../unified/webhook_url";
import i18n from "../i18n";


async function getWebhookSettings(c: Context<HonoCustomType>): Promise<Response> {
    const msgs = i18n.getMessagesbyContext(c);
    const { address } = c.get("jwtPayload")
    const adminSettings = await c.env.KV.get<AdminWebhookSettings>(CONSTANTS.WEBHOOK_KV_SETTINGS_KEY, "json");
    if (adminSettings?.enableAllowList && !adminSettings?.allowList.includes(address)) {
        return c.text(msgs.WebhookNotAllowedForUserMsg, 403);
    }
    const settings = await c.env.KV.get<WebhookSettings>(
        `${CONSTANTS.WEBHOOK_KV_USER_SETTINGS_KEY}:${address}`, "json"
    ) || new WebhookSettings();
    return c.json(settings);
}


async function saveWebhookSettings(c: Context<HonoCustomType>): Promise<Response> {
    const msgs = i18n.getMessagesbyContext(c);
    const { address } = c.get("jwtPayload")
    const adminSettings = await c.env.KV.get<AdminWebhookSettings>(CONSTANTS.WEBHOOK_KV_SETTINGS_KEY, "json");
    if (adminSettings?.enableAllowList && !adminSettings?.allowList.includes(address)) {
        return c.text(msgs.WebhookNotAllowedForUserMsg, 403);
    }
    const settings = await c.req.json<WebhookSettings>();
    // I7d：用户（allow-list 内）设置的 webhook URL 保存时即校验 SSRF（拒私有/回环/
    // 元数据地址，坏 URL 不落库）。allow-list 用户不是全信主体——URL 到端点是他们自己
    // 可选的，落到内网即 SSRF。
    if (!isSafeWebhookUrl(settings.url)) {
        return c.text("unsafe webhook url", 400);
    }
    await c.env.KV.put(
        `${CONSTANTS.WEBHOOK_KV_USER_SETTINGS_KEY}:${address}`,
        JSON.stringify(settings));
    return c.json({ success: true })
}

async function testWebhookSettings(c: Context<HonoCustomType>): Promise<Response> {
    const settings = await c.req.json<WebhookSettings>();
    const { address } = c.get("jwtPayload");
    // random raw email
    const mailRow = await c.env.DB.prepare(
        `SELECT * FROM raw_mails WHERE address = ? ORDER BY RANDOM() LIMIT 1`
    ).bind(address).first<RawMailRow>();
    const mailId = mailRow?.id;
    const raw = mailRow ? await resolveRawEmail(mailRow) : "";
    const parsedEmailContext: ParsedEmailContext = { rawEmail: raw };
    const parsedEmail = await commonParseMail(parsedEmailContext);
    const res = await sendWebhook(settings, {
        id: mailId || "0",
        url: c.env.FRONTEND_URL ? `${c.env.FRONTEND_URL}?mail_id=${mailId}` : "",
        from: parsedEmail?.sender || "test@test.com",
        to: address,
        subject: parsedEmail?.subject || "test subject",
        raw: raw || "test raw email",
        parsedText: parsedEmail?.text || "test parsed text",
        parsedHtml: parsedEmail?.html || "test parsed html",
        aiExtract: null,
        aiExtractType: "",
        aiExtractResult: "",
        aiExtractResultText: ""
    });
    if (!res.success) {
        return c.text(res.message || "send webhook error", 400);
    }
    return c.json({ success: true });
}

export default {
    getWebhookSettings,
    saveWebhookSettings,
    testWebhookSettings,
}
