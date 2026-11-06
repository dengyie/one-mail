import type { Context } from "hono";

import type { commonParseMail, triggerAnotherWorker, triggerWebhook } from "../common";
import type { ExtractResult } from "../models";
import type { sendMailToTelegram } from "../telegram_api";
import type { extractEmailInfo } from "./ai_extract";

/**
 * Post-ingest side effects.
 *
 * Everything here is best-effort: AI extraction, Telegram push, webhooks and
 * peer-worker fan-out must never decide whether the message was accepted, and
 * no one step may block the next. The inbound hot path only awaits address
 * checks and durable storage; this module runs inside `ctx.waitUntil()`.
 *
 * Dependencies are injected (and imported as types only) so the module stays
 * import-free at runtime and can be unit-tested with plain `node --test`.
 */
export type PostIngestParams = {
    rawEmail: string;
    from: string;
    toAddress: string;
    messageId: string | null;
    headers: Headers;
    parsedEmailContext: ParsedEmailContext;
};

export type PostIngestDeps = {
    extractEmailInfo: typeof extractEmailInfo;
    sendMailToTelegram: typeof sendMailToTelegram;
    triggerWebhook: typeof triggerWebhook;
    commonParseMail: typeof commonParseMail;
    triggerAnotherWorker: typeof triggerAnotherWorker;
};

export async function runPostIngest(
    env: Bindings,
    params: PostIngestParams,
    deps: PostIngestDeps,
): Promise<void> {
    const c = { env } as Context<HonoCustomType>;

    let aiExtractResult: ExtractResult | null = null;
    try {
        aiExtractResult = await deps.extractEmailInfo(
            params.parsedEmailContext,
            env,
            params.messageId,
            params.toAddress,
        );
    } catch (error) {
        console.error("AI email extraction failed", error);
    }

    try {
        await deps.sendMailToTelegram(
            c,
            params.toAddress,
            params.parsedEmailContext,
            params.messageId,
            aiExtractResult,
        );
    } catch (error) {
        console.error("send mail to telegram error", error);
    }

    try {
        await deps.triggerWebhook(
            c,
            params.toAddress,
            params.parsedEmailContext,
            params.messageId,
            aiExtractResult,
        );
    } catch (error) {
        console.error("send webhook error", error);
    }

    try {
        const parsedEmail = await deps.commonParseMail(params.parsedEmailContext);
        const rpcEmail: RPCEmailMessage = {
            from: params.from,
            to: params.toAddress,
            rawEmail: params.rawEmail,
            headers: params.headers,
        };
        await deps.triggerAnotherWorker(c, rpcEmail, parsedEmail?.text ?? "");
    } catch (error) {
        console.error("trigger another worker error", error);
    }
}