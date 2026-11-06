/**
 * Webhook delivery primitives, extracted out of the (frozen-oversized) common.ts.
 *
 * Delivery is best-effort and runs inside waitUntil(): a webhook that never
 * responds would otherwise hold the background task open, so every outbound
 * call is bounded by WEBHOOK_TIMEOUT_MS.
 */

import { isSafeWebhookUrl } from '../unified/webhook_url';
import { WebhookSettings } from '../models';
import type { WebhookMail } from '../models';

export const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * Webhook `headers` is persisted as a free-form string from the settings UI.
 * Reject anything that is not a JSON object (or empty, meaning "no custom
 * headers") at save time, so a broken value cannot be stored and then throw on
 * every delivery. `sendWebhook` re-checks defensively for values already stored.
 */
export const isValidWebhookHeaders = (raw: unknown): boolean => {
    if (typeof raw !== "string") return false;
    if (raw.trim() === "") return true;
    try {
        const parsed = JSON.parse(raw);
        return !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
    } catch {
        return false;
    }
};

export async function sendWebhook(
    settings: WebhookSettings, formatMap: WebhookMail
): Promise<{ success: boolean, message?: string }> {
    // send webhook
    let body = settings.body;
    for (const key of Object.keys(formatMap)) {
        body = body.replace(
            new RegExp(`\\$\\{${key}\\}`, "g"),
            JSON.stringify(
                formatMap[key as keyof WebhookMail]
            ).replace(/^"(.*)"$/, '$1')
        );
    }
    // I7d webhook SSRF 防护：URL 由 admin 或 allow-list 内用户可配，若指向
    // 169.254.169.254/内网等地址即可做 SSRF。Workers 无 dns/net 模块，fetch 时
    // 的 DNS-rebinding 无法全拦——这里做静态 best-effort 校验（拒私有/回环/元数据），
    // 运行时 rebinding 仍为残留风险（见 changelog）。
    if (!isSafeWebhookUrl(settings.url)) {
        console.warn("send webhook blocked unsafe url", settings.url);
        return { success: false, message: "unsafe webhook url (private/internal IP or invalid)" };
    }
    // settings.headers is a free-form string persisted from the settings UI. A
    // non-JSON value must fail this one delivery, not throw: triggerWebhook
    // awaits this in a loop, so a throw would silently skip every later webhook.
    let headers: Record<string, string> = {};
    if (typeof settings.headers === "string" && settings.headers.trim() !== "") {
        try {
            const parsed = JSON.parse(settings.headers);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new TypeError("webhook headers must be a JSON object");
            }
            headers = parsed as Record<string, string>;
        } catch {
            console.warn("send webhook blocked invalid headers json", settings.url);
            return { success: false, message: "invalid webhook headers (must be a JSON object)" };
        }
    }
    const response = await fetch(settings.url, {
        method: settings.method,
        headers,
        body: body,
        // AbortSignal.timeout exists in workerd and Node 18+; guard so an older
        // runtime degrades to the previous unbounded behaviour instead of throwing.
        ...(typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
            ? { signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS) }
            : {}),
    });
    if (!response.ok) {
        console.log("send webhook error", settings.url, settings.method, settings.headers, body);
        console.log("send webhook error", response.status, response.statusText);
        return { success: false, message: `send webhook error: ${response.status} ${response.statusText}` };
    }
    return { success: true }
}