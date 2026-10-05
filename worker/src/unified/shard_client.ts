import { SHARD_FETCH_TIMEOUT_MS } from "./shard_merge.ts";
import type { ShardEndpoint } from "./shard_map.ts";

export const SHARD_SCOPE_HEADER = "x-one-mail-shard-scope";
export type ShardRequestScope = { account_ids: string[] | null; sources: string[] | null };
export class ShardTransportError extends Error {
    readonly code: string;
    readonly shard_id: string;
    readonly cancellationCauses: unknown[] = [];
    cleanup: Promise<void> = Promise.resolve();
    constructor(code: string, shardId: string, cause?: unknown) {
        super(`Shard transport failed: ${code}`, { cause });
        this.name = "ShardTransportError";
        this.code = code;
        this.shard_id = shardId;
    }
}
export type ShardCallResult<T> =
    | { ok: true; shard_id: string; data: T }
    | { ok: false; shard_id: string; error: string; cause?: unknown };
export type ShardFetchOptions = {
    method?: string;
    body?: unknown;
    scope?: ShardRequestScope;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
};
export const shardAuthorizationHeader = (token: string): string => `Bearer ${token}`;
export const readBearerToken = (request: Request): string => {
    const auth = request.headers.get("authorization");
    return auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
};

export const fetchShardJson = async <T>(
    shard: ShardEndpoint,
    path: string,
    init: ShardFetchOptions = {},
): Promise<ShardCallResult<T>> => {
    const ac = new AbortController();
    const timeoutMs = init.timeoutMs ?? SHARD_FETCH_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let stage: "network" | "body" = "network";
    let failure: ShardTransportError | undefined;
    const cancellations: Promise<void>[] = [];
    const cancellationCauses: unknown[] = [];
    const cancel = (target: { cancel(): Promise<unknown> }): void => {
        // Keep cancellation attached to the returned diagnostic lifecycle, without
        // extending the response deadline when a stream's cancel algorithm stalls.
        const task = target.cancel().then(() => undefined, (cause: unknown) => {
            cancellationCauses.push(cause);
            failure?.cancellationCauses.push(cause);
        });
        cancellations.push(task);
        if (failure) failure.cleanup = Promise.all(cancellations).then(() => undefined);
    };
    const fail = (code: string, cause?: unknown): ShardCallResult<T> => {
        failure = new ShardTransportError(code, shard.id, cause);
        failure.cancellationCauses.push(...cancellationCauses);
        failure.cleanup = Promise.all(cancellations).then(() => undefined);
        return { ok: false, shard_id: shard.id, error: code, cause };
    };
    try {
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > SHARD_FETCH_TIMEOUT_MS) {
            throw new Error("Invalid shard timeout");
        }
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                ac.abort();
                if (reader) cancel(reader);
                reject(new Error("Shard request timed out"));
            }, timeoutMs);
        });
        const work = async (): Promise<ShardCallResult<T>> => {
            const headers: Record<string, string> = {
                authorization: shardAuthorizationHeader(shard.token),
                "content-type": "application/json",
            };
            if (init.scope) headers[SHARD_SCOPE_HEADER] = encodeURIComponent(JSON.stringify(init.scope));
            const response = await (init.fetchImpl ?? fetch)(
                `${shard.base_url}${path.startsWith("/") ? path : `/${path}`}`,
                {
                    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
                    headers,
                    body: init.body === undefined ? undefined : JSON.stringify(init.body),
                    signal: ac.signal,
                    redirect: "error",
                },
            );
            if (ac.signal.aborted) {
                if (response.body) cancel(response.body);
                throw new Error("Shard request timed out");
            }
            if (!response.ok) {
                if (response.body) cancel(response.body);
                return fail(`http_${response.status}`);
            }
            stage = "body";
            // Bound memory while retaining the deadline for the entire body read.
            const chunks: Uint8Array[] = [];
            let bytes = 0;
            if (response.body) {
                reader = response.body.getReader();
                while (true) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    bytes += chunk.value.byteLength;
                    if (bytes > 16 * 1024 * 1024) {
                        if (reader) cancel(reader);
                        return fail("body_too_large");
                    }
                    chunks.push(chunk.value);
                }
            }
            const body = new Uint8Array(bytes);
            let offset = 0;
            for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
            try {
                const text = new TextDecoder().decode(body);
                const data: unknown = JSON.parse(text);
                if (data === null || typeof data !== "object") throw new Error("Invalid shard JSON envelope");
                return { ok: true, shard_id: shard.id, data: data as T };
            } catch (cause) {
                return fail(`invalid_json:${response.status}`, cause);
            }
        };
        return await Promise.race([work(), deadline]);
    } catch (cause) {
        if (reader) cancel(reader);
        return fail(ac.signal.aborted ? "timeout" : stage, cause);
    } finally {
        clearTimeout(timer);
    }
};
export const fanOutShards = async <T>(
    shards: readonly ShardEndpoint[], path: string, init: ShardFetchOptions = {},
): Promise<ShardCallResult<T>[]> => Promise.all(shards.map((shard) => fetchShardJson<T>(shard, path, init)));
