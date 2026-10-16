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
import {
    AttachmentStorageError,
    downloadAttachmentObject,
    uploadAttachmentObject,
} from "./storage_client.ts";

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

class AttachmentBodyLengthError extends Error {
    constructor() {
        super("attachment content length mismatch");
        this.name = "AttachmentBodyLengthError";
    }
}

type AttachmentUploadBody = {
    stream: ReadableStream<Uint8Array> | Uint8Array;
    size: () => number;
    declared: number;
    failure: () => Error | null;
};

const bodyStream = (c: Context<HonoCustomType>): AttachmentUploadBody | Response => {
    const contentLength = c.req.raw.headers.get("content-length");
    if (contentLength === null) return c.json({ error: "content-length required" }, 411);
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_ATTACHMENT_BYTES) {
        return c.json({ error: "attachment too large" }, 413);
    }
    const source = c.req.raw.body;
    if (!source) {
        if (declared !== 0) return {
            stream: new Uint8Array(0), size: () => 0, declared,
            failure: () => new AttachmentBodyLengthError(),
        };
        return { stream: new Uint8Array(0), size: () => 0, declared, failure: () => null };
    }
    const reader = source.getReader();
    let total = 0;
    let released = false;
    let streamFailure: Error | null = null;
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
                    if (total !== declared) {
                        streamFailure = new AttachmentBodyLengthError();
                        controller.error(streamFailure);
                        return;
                    }
                    controller.close();
                    return;
                }
                total += part.value.byteLength;
                if (total > declared) {
                    await reader.cancel().catch(() => undefined);
                    release();
                    streamFailure = new AttachmentBodyLengthError();
                    controller.error(streamFailure);
                    return;
                }
                if (total > MAX_ATTACHMENT_BYTES) {
                    await reader.cancel().catch(() => undefined);
                    release();
                    streamFailure = new AttachmentTooLargeError();
                    controller.error(streamFailure);
                    return;
                }
                controller.enqueue(part.value);
            } catch (error) {
                release();
                if (error instanceof Error) streamFailure = error;
                controller.error(error);
            }
        },
        async cancel(reason) {
            await reader.cancel(reason).catch(() => undefined);
            release();
        },
    });
    return { stream, size: () => total, declared, failure: () => streamFailure };
};

export const uploadAttachment = async (c: Context<HonoCustomType>) => {
    const accountId = pathPart(c.req.param("accountId"));
    const emailId = pathPart(c.req.param("emailId"));
    const attachmentId = c.req.param("attachmentId");
    if (!accountId || !emailId || !safeAttachmentId(attachmentId)) return c.json({ error: "invalid attachment identity" }, 400);
    if (!c.env.ATTACHMENT_STORAGE_URL || !c.env.ATTACHMENT_STORAGE_TOKEN) {
        return c.json({ error: "attachment storage is not configured" }, 503);
    }
    const body = bodyStream(c);
    if (body instanceof Response) return body;
    const key = await attachmentKey(accountId, emailId, attachmentId);
    // Register cleanup before writing the object. If storage succeeds but D1 is
    // unavailable, the object is still durably discoverable by retention GC.
    if (!(await attachmentGcInsert(c.env, key))) {
        return c.json({ error: "attachment cleanup in progress; retry upload" }, 503, { "retry-after": "10" });
    }
    try {
        await uploadAttachmentObject(c.env, key, body.stream, body.declared,
            safeMimeType(c.req.raw.headers.get("x-one-mail-mime-type")),
            safeAttachmentName(c.req.raw.headers.get("x-one-mail-name")), c.req.raw.signal);
    } catch (error) {
        const bodyFailure = body.failure();
        if (bodyFailure instanceof AttachmentTooLargeError) return c.json({ error: "attachment too large" }, 413);
        if (bodyFailure instanceof AttachmentBodyLengthError) return c.json({ error: "content-length mismatch" }, 400);
        if (error instanceof AttachmentTooLargeError) return c.json({ error: "attachment too large" }, 413);
        if (error instanceof AttachmentBodyLengthError) return c.json({ error: "content-length mismatch" }, 400);
        if (error instanceof AttachmentStorageError && error.message === "attachment too large") {
            return c.json({ error: "attachment too large" }, 413);
        }
        if (error instanceof AttachmentStorageError) {
            return c.json({ error: "attachment storage unavailable" }, 503, { "retry-after": "30" });
        }
        throw error;
    }
    return c.json({ id: attachmentId, storage_key: key, size: body.size() });
};

export const downloadAttachment = async (c: Context<HonoCustomType>, existingRow?: Record<string, unknown>) => {
    const emailId = pathPart(c.req.param("id"));
    const attachmentId = c.req.param("attachmentId");
    if (!emailId || !safeAttachmentId(attachmentId)) return c.json({ error: "invalid attachment identity" }, 400);
    if (!c.env.ATTACHMENT_STORAGE_URL || !c.env.ATTACHMENT_STORAGE_TOKEN) {
        return c.json({ error: "attachment storage is not configured" }, 503);
    }
    const row = existingRow && typeof existingRow === "object"
        ? existingRow
        : await c.env.DB.prepare(`SELECT * FROM emails WHERE id = ?`).bind(emailId).first<Record<string, unknown>>();
    if (!row) return c.json({ error: "not found" }, 404);
    if (!(await checkRowAccess(c, row))) return c.json({ error: "forbidden" }, 403);
    const attachments = parseAttachments(row.attachments_json);
    const attachment = attachments.find(item => item.id === attachmentId);
    if (!attachment?.storage_key || !safeAttachmentKey(attachment.storage_key)
        || typeof row.account_id !== "string" || !row.account_id) return c.json({ error: "attachment not found" }, 404);
    const expectedKey = await attachmentKey(row.account_id, emailId, attachment.id);
    if (attachment.storage_key !== expectedKey) return c.json({ error: "attachment not found" }, 404);
    let object: Awaited<ReturnType<typeof downloadAttachmentObject>>;
    try {
        object = await downloadAttachmentObject(c.env, attachment.storage_key, c.req.raw.signal);
    } catch (error) {
        if (error instanceof AttachmentStorageError && error.status === 404) {
            return c.json({ error: "attachment not found" }, 404);
        }
        if (error instanceof AttachmentStorageError) return c.json({ error: "attachment unavailable" }, 503);
        throw error;
    }
    const headers = attachmentResponseHeaders(attachment);
    // The stored object length is authoritative. Metadata can come from an old
    // or partially migrated row and must never produce a truncated response.
    headers.set("content-length", String(object.size));
    return new Response(object.body, { headers });
};
