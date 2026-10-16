import { MAX_ATTACHMENT_BYTES, safeAttachmentKey, safeMimeType } from "./attachments.ts";

const STORAGE_TIMEOUT_MS = 90_000;
const STORAGE_DELETE_TIMEOUT_MS = 10_000;

export class AttachmentStorageError extends Error {
    readonly status: number | null;

    constructor(message: string, status: number | null = null) {
        super(message);
        this.name = "AttachmentStorageError";
        this.status = status;
    }
}

type StorageEnv = Pick<Bindings, "ATTACHMENT_STORAGE_URL" | "ATTACHMENT_STORAGE_TOKEN">;

const storageConfig = (env: StorageEnv): { baseUrl: string; token: string } => {
    const rawUrl = typeof env.ATTACHMENT_STORAGE_URL === "string"
        ? env.ATTACHMENT_STORAGE_URL.trim().replace(/\/+$/, "")
        : "";
    const token = typeof env.ATTACHMENT_STORAGE_TOKEN === "string"
        ? env.ATTACHMENT_STORAGE_TOKEN
        : "";
    let url: URL;
    try { url = new URL(rawUrl); } catch { throw new AttachmentStorageError("attachment storage is not configured"); }
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash || !token) {
        throw new AttachmentStorageError("attachment storage is not configured");
    }
    return { baseUrl: rawUrl, token };
};

const storageRequest = async (
    env: StorageEnv,
    key: string,
    init: RequestInit,
): Promise<Response> => {
    if (!safeAttachmentKey(key)) throw new AttachmentStorageError("invalid attachment storage key");
    const { baseUrl, token } = storageConfig(env);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STORAGE_TIMEOUT_MS);
    let handedOff = false;
    const onCallerAbort = (): void => controller.abort(init.signal?.reason);
    init.signal?.addEventListener("abort", onCallerAbort, { once: true });
    const cleanup = (): void => {
        clearTimeout(timer);
        init.signal?.removeEventListener("abort", onCallerAbort);
    };
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("x-content-type-options", "nosniff");
    try {
        const objectId = key.slice("unified/".length);
        const response = await fetch(`${baseUrl}/unified/${encodeURIComponent(objectId)}`, {
            ...init,
            headers,
            signal: controller.signal,
            redirect: "manual",
        });
        const expectedStatus = init.method === "GET" ? 200 : 204;
        if (response.status !== expectedStatus) {
            controller.abort(new AttachmentStorageError("attachment storage request failed", response.status));
            cleanup();
            await response.body?.cancel().catch(() => undefined);
            throw new AttachmentStorageError("attachment storage request failed", response.status);
        }
        if (init.method !== "GET" || !response.body) {
            cleanup();
            return response;
        }
        const reader = response.body.getReader();
        let total = 0;
        let closed = false;
        const close = (): void => {
            if (closed) return;
            closed = true;
            cleanup();
            try { reader.releaseLock(); } catch { /* already released */ }
        };
        const body = new ReadableStream<Uint8Array>({
            async pull(streamController) {
                try {
                    const part = await reader.read();
                    if (part.done) {
                        close();
                        streamController.close();
                        return;
                    }
                    total += part.value.byteLength;
                    if (total > MAX_ATTACHMENT_BYTES) {
                        await reader.cancel().catch(() => undefined);
                        close();
                        streamController.error(new AttachmentStorageError("attachment unavailable"));
                        return;
                    }
                    streamController.enqueue(part.value);
                } catch (error) {
                    close();
                    streamController.error(error);
                }
            },
            async cancel(reason) {
                controller.abort(reason);
                await reader.cancel(reason).catch(() => undefined);
                close();
            },
        });
        handedOff = true;
        return new Response(body, { status: response.status, headers: response.headers });
    } catch (error) {
        cleanup();
        if (error instanceof AttachmentStorageError) throw error;
        throw new AttachmentStorageError("attachment storage request failed");
    } finally {
        if (!handedOff) cleanup();
    }
};

export const uploadAttachmentObject = async (
    env: StorageEnv,
    key: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    size: number,
    mimeType: unknown,
    name: unknown,
    signal?: AbortSignal,
): Promise<void> => {
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ATTACHMENT_BYTES) {
        throw new AttachmentStorageError("attachment too large");
    }
    const response = await storageRequest(env, key, {
        method: "PUT",
        body: body as BodyInit,
        headers: {
            "content-type": safeMimeType(mimeType),
            "content-length": String(size),
            "connection": "close",
            "x-one-mail-name": typeof name === "string" ? name : "attachment",
        },
        signal,
    });
    await response.body?.cancel().catch(() => undefined);
};

export const downloadAttachmentObject = async (
    env: StorageEnv,
    key: string,
    signal?: AbortSignal,
): Promise<{ body: ReadableStream<Uint8Array>; size: number }> => {
    const response = await storageRequest(env, key, { method: "GET", signal });
    const size = Number(response.headers.get("content-length") || "-1");
    if (!response.body || !Number.isSafeInteger(size) || size < 0 || size > MAX_ATTACHMENT_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        throw new AttachmentStorageError("attachment unavailable");
    }
    return {
        body: response.body,
        size,
    };
};

export const deleteAttachmentObject = async (env: StorageEnv, key: string): Promise<void> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STORAGE_DELETE_TIMEOUT_MS);
    try {
        await storageRequest(env, key, { method: "DELETE", signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
};
