import type { Context } from "hono";
import {
    MAX_ATTACHMENT_BYTES,
    attachmentGcInsert,
    attachmentKey,
    attachmentResponseHeaders,
    parseAttachments,
    safeAttachmentId,
    safeAttachmentKey,
    safeAttachmentName,
    safeMimeType,
} from "./attachments.ts";
import { checkRowAccess } from "./auth_scope.ts";

export const attachmentDownloadRateLimit = async (c: Context<HonoCustomType>, next: () => Promise<void>) => {
    const limiter = c.env.RATE_LIMITER;
    if (limiter) {
        const user = c.get("unifiedUserAuth")?.userPayload?.user_id;
        const apiKey = c.get("apiKey")?.id;
        const ip = c.req.raw.headers.get("cf-connecting-ip") || c.req.raw.headers.get("x-fingerprint") || "unknown";
        const principal = user ? `user:${user}` : apiKey ? `key:${apiKey}` : `admin:${ip}`;
        const { success } = await limiter.limit({ key: `unified-attachment-download:${principal}` });
        if (!success) return c.json({ error: "attachment download rate limit exceeded" }, 429, { "retry-after": "60" });
    }
    await next();
};


const pathPart = (value: unknown, max = 200): string | null =>
    typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("/") ? value : null;

class AttachmentTooLargeError extends Error {
    constructor() {
        super("attachment too large");
        this.name = "AttachmentTooLargeError";
    }
}

type AttachmentUploadBody = { stream: ReadableStream<Uint8Array> | Uint8Array; size: () => number };

const bodyStream = (c: Context<HonoCustomType>): AttachmentUploadBody | Response => {
    const declared = Number(c.req.raw.headers.get("content-length") || "0");
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_ATTACHMENT_BYTES) {
        return c.json({ error: "attachment too large" }, 413);
    }
    const source = c.req.raw.body;
    if (!source) return { stream: new Uint8Array(0), size: () => 0 };
    const reader = source.getReader();
    let total = 0;
    let released = false;
    const release = (): void => {
        if (released) return;
        released = true;
        try { reader.releaseLock(); } catch { /* already released */ }
    };
    const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const part = await reader.read();
                if (part.done) {
                    release();
                    controller.close();
                    return;
                }
                total += part.value.byteLength;
                if (total > MAX_ATTACHMENT_BYTES) {
                    await reader.cancel().catch(() => undefined);
                    release();
                    controller.error(new AttachmentTooLargeError());
                    return;
                }
                controller.enqueue(part.value);
            } catch (error) {
                release();
                controller.error(error);
            }
        },
        async cancel(reason) {
            await reader.cancel(reason).catch(() => undefined);
            release();
        },
    });
    return { stream, size: () => total };
};

export const uploadAttachment = async (c: Context<HonoCustomType>) => {
    const accountId = pathPart(c.req.param("accountId"));
    const emailId = pathPart(c.req.param("emailId"));
    const attachmentId = c.req.param("attachmentId");
    if (!accountId || !emailId || !safeAttachmentId(attachmentId)) return c.json({ error: "invalid attachment identity" }, 400);
    if (!c.env.ATTACHMENTS) return c.json({ error: "attachment storage is not configured" }, 503);
    const body = bodyStream(c);
    if (body instanceof Response) return body;
    const key = await attachmentKey(accountId, emailId, attachmentId);
    // Register cleanup before writing the object. If R2 succeeds but D1 is
    // unavailable, the object is still durably discoverable by retention GC.
    if (!(await attachmentGcInsert(c.env, key))) {
        return c.json({ error: "attachment cleanup in progress; retry upload" }, 503, { "retry-after": "10" });
    }
    try {
        await c.env.ATTACHMENTS.put(key, body.stream, {
            httpMetadata: { contentType: safeMimeType(c.req.raw.headers.get("x-one-mail-mime-type")) },
            customMetadata: { name: safeAttachmentName(c.req.raw.headers.get("x-one-mail-name")) },
        });
    } catch (error) {
        if (error instanceof AttachmentTooLargeError) return c.json({ error: "attachment too large" }, 413);
        throw error;
    }
    return c.json({ id: attachmentId, r2_key: key, size: body.size() });
};

export const downloadAttachment = async (c: Context<HonoCustomType>) => {
    const emailId = pathPart(c.req.param("id"));
    const attachmentId = c.req.param("attachmentId");
    if (!emailId || !safeAttachmentId(attachmentId)) return c.json({ error: "invalid attachment identity" }, 400);
    if (!c.env.ATTACHMENTS) return c.json({ error: "attachment storage is not configured" }, 503);
    const row = await c.env.DB.prepare(`SELECT * FROM emails WHERE id = ?`).bind(emailId).first<Record<string, unknown>>();
    if (!row) return c.json({ error: "not found" }, 404);
    if (!(await checkRowAccess(c, row))) return c.json({ error: "forbidden" }, 403);
    const attachments = parseAttachments(row.attachments_json);
    const attachment = attachments.find(item => item.id === attachmentId);
    if (!attachment?.r2_key || !safeAttachmentKey(attachment.r2_key)
        || typeof row.account_id !== "string" || !row.account_id) return c.json({ error: "attachment not found" }, 404);
    const expectedKey = await attachmentKey(row.account_id, emailId, attachment.id);
    if (attachment.r2_key !== expectedKey) return c.json({ error: "attachment not found" }, 404);
    const object = await c.env.ATTACHMENTS.get(attachment.r2_key);
    if (!object?.body) return c.json({ error: "attachment not found" }, 404);
    if (!Number.isSafeInteger(object.size) || object.size < 0 || object.size > MAX_ATTACHMENT_BYTES) {
        return c.json({ error: "attachment unavailable" }, 503);
    }
    const headers = attachmentResponseHeaders(attachment);
    // The stored object length is authoritative. Metadata can come from an old
    // or partially migrated row and must never produce a truncated response.
    headers.set("content-length", String(object.size));
    const metadataType = object.httpMetadata?.contentType;
    if (metadataType) headers.set("content-type", safeMimeType(metadataType));
    return new Response(object.body, { headers });
};
