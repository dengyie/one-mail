import type { Context } from "hono";

import { getBooleanValue, getJsonSetting, normalizeAddressDomain } from "../utils";
import { commonParseMail, triggerAnotherWorker, triggerWebhook } from "../common";
import { sendMailToTelegram } from "../telegram_api";
import { auto_reply } from "./auto_reply";
import { extractEmailInfo } from "./ai_extract";
import { isBlocked } from "./black_list";
import { check_if_junk_mail } from "./check_junk";
import { remove_attachment_if_need } from "./check_attachment";
import { forwardEmail } from "./forward";
import { runPostIngest, type PostIngestDeps } from "./post_ingest";
import { EmailRuleSettings } from "../models";
import { CONSTANTS } from "../constants";
import { compressText } from "../gzip";
import { saveUnifiedEmail } from "../unified/unified_store";
import { enqueueUnifiedMirror, markUnifiedMirrorComplete } from "../unified/mirror_jobs.ts";


const postIngestDeps: PostIngestDeps = {
    extractEmailInfo,
    sendMailToTelegram,
    triggerWebhook,
    commonParseMail,
    triggerAnotherWorker,
};

async function email(message: ForwardableEmailMessage, env: Bindings, ctx: ExecutionContext) {
    const toAddress = normalizeAddressDomain(message.to);
    if (await isBlocked(message.from, env)) {
        message.setReject("Reject from address");
        console.log(`Reject message from ${message.from} to ${toAddress}`);
        return;
    }
    const rawEmail = await new Response(message.raw).text();
    const parsedEmailContext: ParsedEmailContext = {
        rawEmail: rawEmail
    };

    // check if junk mail
    try {
        const is_junk = await check_if_junk_mail(env, toAddress, parsedEmailContext, message.headers.get("Message-ID"));
        if (is_junk) {
            message.setReject("Junk mail");
            console.log(`Junk mail from ${message.from} to ${toAddress}`);
            return;
        }
    } catch (error) {
        console.error("check junk mail error", error);
    }

    // check if unknown address mail
    try {
        const emailRuleSettings = await getJsonSetting<EmailRuleSettings>(
            { env: env } as Context<HonoCustomType>, CONSTANTS.EMAIL_RULE_SETTINGS_KEY
        );
        if (emailRuleSettings?.blockReceiveUnknowAddressEmail) {
            // toAddress 只会是本站 mangoqwq 域地址（CF Email Routing 仅对本站域路由
            // 到此 Worker；外部邮箱经聚合器 IMAP/POP3 抓取走 ingest 路径，不进这里）。
            // 仍排除 source_meta='external' 引用行以明确语义：外部引用行不计作「本站已知
            // 地址」，避免管理员误把外部引用当本站地址放行（防御性，域名不同本不冲突）。
            const db_address_id = await env.DB.prepare(
                `SELECT id FROM address where name = ? AND (source_meta IS NULL OR source_meta != 'external')`
            ).bind(toAddress).first("id");
            if (!db_address_id) {
                message.setReject("Unknown address");
                console.log(`Unknown address mail from ${message.from} to ${toAddress}`);
                return;
            }
        }
    } catch (error) {
        console.error("check unknown address mail error", error);
    }

    // remove attachment if configured or size > 2MB
    try {
        await remove_attachment_if_need(env, parsedEmailContext, message.from, toAddress, message.rawSize);
    } catch (error) {
        console.error("remove attachment error", error);
    }

    const message_id = message.headers.get("Message-ID");
    // save email
    let savedToInbox = false;
    let rawMailId: number | null = null;
    const unifiedId = `native-${crypto.randomUUID()}`;
    try {
        let success = false;
        const captureRawResult = (result: D1Result<unknown>): void => {
            success = result.success;
            const lastRowId = (result.meta as { last_row_id?: unknown } | undefined)?.last_row_id;
            rawMailId = Number.isSafeInteger(lastRowId) ? Number(lastRowId) : null;
        };
        if (getBooleanValue(env.ENABLE_MAIL_GZIP)) {
            let compressed: ArrayBuffer | null = null;
            try {
                compressed = await compressText(parsedEmailContext.rawEmail);
            } catch (gzipError) {
                console.error("gzip compression failed, falling back to plaintext", gzipError);
            }
            if (compressed) {
                try {
                    captureRawResult(await env.DB.prepare(
                        `INSERT INTO raw_mails (source, address, raw_blob, message_id, unified_id, mirror_pending) VALUES (?, ?, ?, ?, ?, 1)`
                    ).bind(
                        message.from, toAddress, compressed, message_id, unifiedId
                    ).run());
                } catch (dbError) {
                    // Fallback to plaintext only if raw_blob column is missing (migration not applied)
                    const errMsg = String(dbError);
                    if (errMsg.includes('raw_blob') || errMsg.includes('no such column')) {
                        console.error("raw_blob column missing, falling back to plaintext", dbError);
                        captureRawResult(await env.DB.prepare(
                            `INSERT INTO raw_mails (source, address, raw, message_id, unified_id, mirror_pending) VALUES (?, ?, ?, ?, ?, 1)`
                        ).bind(
                            message.from, toAddress, parsedEmailContext.rawEmail, message_id, unifiedId
                        ).run());
                    } else {
                        throw dbError;
                    }
                }
            } else {
                captureRawResult(await env.DB.prepare(
                    `INSERT INTO raw_mails (source, address, raw, message_id, unified_id, mirror_pending) VALUES (?, ?, ?, ?, ?, 1)`
                ).bind(
                    message.from, toAddress, parsedEmailContext.rawEmail, message_id, unifiedId
                ).run());
            }
        } else {
            captureRawResult(await env.DB.prepare(
                `INSERT INTO raw_mails (source, address, raw, message_id, unified_id, mirror_pending) VALUES (?, ?, ?, ?, ?, 1)`
            ).bind(
                message.from, toAddress, parsedEmailContext.rawEmail, message_id, unifiedId
            ).run());
        }
        if (!success) {
            console.error(`Failed save message from ${message.from} to ${toAddress}`);
        } else {
            savedToInbox = true;
        }
    }
    catch (error) {
        console.error("save email error", error);
    }
    if (!savedToInbox) {
        message.setReject(`Failed save message to ${toAddress}`);
        return;
    }

    // one-mail: mirror into unified emails table (never block base ingest)
    try {
        await saveUnifiedEmail(
            { env } as Context<HonoCustomType>, parsedEmailContext.rawEmail, message.from, toAddress,
            unifiedId,
        );
        await markUnifiedMirrorComplete(env, unifiedId);
    } catch (error) {
        console.warn("save unified email error", error);
        if (rawMailId != null) {
            try {
                await enqueueUnifiedMirror(env, rawMailId, unifiedId, error);
            } catch (queueError) {
                console.error("enqueue unified email mirror retry failed", queueError);
            }
        }
    }

    // Side effects below are best-effort and must never delay or fail delivery:
    // AI extraction, Telegram push, webhooks and peer-worker fan-out run after
    // the message is durably stored, inside ctx.waitUntil().
    const postIngest = runPostIngest(env, {
        rawEmail,
        from: message.from,
        toAddress,
        messageId: message_id,
        headers: message.headers,
        parsedEmailContext,
    }, postIngestDeps).catch((error) => {
        console.error("post-ingest side effects failed", error);
    });
    if (typeof ctx?.waitUntil === "function") {
        ctx.waitUntil(postIngest);
    } else {
        await postIngest;
    }

    // auto_reply uses message.reply() and must stay on the event object, so it
    // remains in the handler; it is still isolated from the post-ingest chain.
    await auto_reply(message, env, toAddress);
}

export { email }
