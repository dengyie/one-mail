import { SHARD_FETCH_TIMEOUT_MS } from "./shard_merge.ts";
import type { ShardEndpoint } from "./shard_map.ts";

export const SHARD_SCOPE_HEADER = "x-one-mail-shard-scope";
export const SHARD_LIST_MAX_BYTES = 512 * 1024;
export const SHARD_DETAIL_MAX_BYTES = 8 * 1024 * 1024;
export const SHARD_RESPONSE_BUDGET_BYTES = 8 * 1024 * 1024;
export const SHARD_FANOUT_CONCURRENCY = 4;
const LEGACY_BODY_MAX_BYTES = 16 * 1024 * 1024;

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
    | { ok: true; shard_id: string; data: T; status?: number }
    | { ok: false; shard_id: string; error: string; cause?: unknown; diagnostics?: ShardTransportError };

/** Request-local cumulative decoded response bytes, not JavaScript heap size.
 * Completed JSON results remain charged until the interaction ends. */
export type ShardResponseBudget = {
    readonly limitBytes: number;
    readonly usedBytes: number;
    reserve(bytes: number): boolean;
};
export const createShardResponseBudget = (limitBytes = SHARD_RESPONSE_BUDGET_BYTES): ShardResponseBudget => {
    if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0 || limitBytes > SHARD_RESPONSE_BUDGET_BYTES) {
        throw new RangeError("Invalid shard response budget");
    }
    let usedBytes = 0;
    return {
        limitBytes,
        get usedBytes() { return usedBytes; },
        reserve(bytes: number): boolean {
            if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limitBytes - usedBytes) return false;
            usedBytes += bytes;
            return true;
        },
    };
};
export type ShardFetchOptions = {
    method?: string;
    body?: unknown;
    scope?: ShardRequestScope;
    timeoutMs?: number;
    /** Absolute deadline on performance.now(), shared with preceding local work. */
    deadlineAtMs?: number;
    signal?: AbortSignal;
    maxBodyBytes?: number;
    responseBudget?: ShardResponseBudget;
    /** Opt in to JSON endpoint errors whose status must reach the caller. */
    acceptedStatuses?: readonly number[];
    fetchImpl?: typeof fetch;
};
export type ShardRequest = {
    shard: ShardEndpoint;
    path: string;
    init?: Omit<ShardFetchOptions, "responseBudget" | "signal" | "deadlineAtMs">;
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
    const maxBodyBytes = init.maxBodyBytes ?? LEGACY_BODY_MAX_BYTES;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let stage: "network" | "body" = "network";
    let failure: ShardTransportError | undefined;
    let failedResult: ShardCallResult<T> | undefined;
    let stopped: { code: "cancelled" | "timeout"; cause: unknown } | undefined;
    let readerCancelled = false;
    const cancellations: Promise<void>[] = [];
    const cancellationCauses: unknown[] = [];
    const recordCleanupError = (cause: unknown): void => {
        cancellationCauses.push(cause);
        failure?.cancellationCauses.push(cause);
    };
    const cancel = (target: { cancel(): Promise<unknown> }): void => {
        // Retain cancellation diagnostics without waiting past the deadline for
        // an underlying stream whose cancel algorithm never settles.
        const task = (async (): Promise<void> => {
            try { await target.cancel(); } catch (cause) { recordCleanupError(cause); }
        })();
        cancellations.push(task);
        if (failure) failure.cleanup = Promise.all(cancellations).then(() => undefined);
    };
    const cancelReader = (): void => {
        if (!reader || readerCancelled) return;
        readerCancelled = true;
        cancel(reader);
    };
    const fail = (code: string, cause?: unknown): ShardCallResult<T> => {
        if (failedResult) return failedResult;
        failure = new ShardTransportError(code, shard.id, cause);
        failure.cancellationCauses.push(...cancellationCauses);
        failure.cleanup = Promise.all(cancellations).then(() => undefined);
        failedResult = { ok: false, shard_id: shard.id, error: code, cause, diagnostics: failure };
        return failedResult;
    };
    let rejectStop: (cause: unknown) => void;
    const stop = (code: "cancelled" | "timeout", cause: unknown): void => {
        if (stopped) return;
        stopped = { code, cause };
        ac.abort(cause);
        cancelReader();
        rejectStop(cause);
    };
    const onCallerAbort = (): void => stop("cancelled", init.signal?.reason);
    try {
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > SHARD_FETCH_TIMEOUT_MS
            || (init.deadlineAtMs !== undefined && !Number.isFinite(init.deadlineAtMs))
            || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0 || maxBodyBytes > LEGACY_BODY_MAX_BYTES) {
            throw new RangeError("Invalid shard request limits");
        }
        if (init.signal?.aborted) return fail("cancelled", init.signal.reason);
        const deadlineAtMs = Math.min(performance.now() + timeoutMs, init.deadlineAtMs ?? Infinity);
        const remainingMs = deadlineAtMs - performance.now();
        if (remainingMs <= 0) return fail("timeout");
        const interruption = new Promise<never>((_, reject) => { rejectStop = reject; });
        init.signal?.addEventListener("abort", onCallerAbort, { once: true });
        const expire = (): void => {
            const remaining = deadlineAtMs - performance.now();
            if (remaining > 0) {
                timer = setTimeout(expire, Math.ceil(remaining));
                return;
            }
            stop("timeout", new Error("Shard request timed out"));
        };
        timer = setTimeout(expire, Math.ceil(remainingMs));
        const checkStopped = (): void => {
            if (performance.now() >= deadlineAtMs) stop("timeout", new Error("Shard request timed out"));
            if (stopped) throw stopped.cause;
        };
        const work = async (): Promise<ShardCallResult<T>> => {
            const headers: Record<string, string> = {
                authorization: shardAuthorizationHeader(shard.token),
                "content-type": "application/json",
            };
            if (init.scope) headers[SHARD_SCOPE_HEADER] = encodeURIComponent(JSON.stringify(init.scope));
            const requestBody = init.body === undefined ? undefined : JSON.stringify(init.body);
            checkStopped();
            const response = await (init.fetchImpl ?? fetch)(
                `${shard.base_url}${path.startsWith("/") ? path : `/${path}`}`,
                {
                    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
                    headers,
                    body: requestBody,
                    signal: ac.signal,
                    redirect: "manual",
                },
            );
            if (stopped || performance.now() >= deadlineAtMs) {
                if (response.body) cancel(response.body);
                checkStopped();
            }
            if ((response.status >= 300 && response.status < 400) || (!response.ok && !init.acceptedStatuses?.includes(response.status))) {
                if (response.body) cancel(response.body);
                return fail(`http_${response.status}`);
            }
            stage = "body";
            const parts: string[] = [];
            const decoder = new TextDecoder();
            let bytes = 0;
            try {
                reader = response.body?.getReader();
                while (reader) {
                    const chunk = await reader.read();
                    checkStopped();
                    if (chunk.done) break;
                    bytes += chunk.value.byteLength;
                    if (bytes > maxBodyBytes) {
                        cancelReader();
                        return fail("body_too_large");
                    }
                    if (init.responseBudget && !init.responseBudget.reserve(chunk.value.byteLength)) {
                        cancelReader();
                        return fail("response_budget_exceeded");
                    }
                    if (chunk.value.byteLength === 0) continue;
                    parts.push(decoder.decode(chunk.value, { stream: true }));
                }
                parts.push(decoder.decode());
                try {
                    const data: unknown = JSON.parse(parts.join(""));
                    checkStopped();
                    if (data === null || typeof data !== "object") throw new Error("Invalid shard JSON envelope");
                    return { ok: true, shard_id: shard.id, data: data as T, status: response.status };
                } catch (cause) {
                    if (stopped) throw cause;
                    return fail(`invalid_json:${response.status}`, cause);
                }
            } catch (cause) {
                cancelReader();
                throw cause;
            } finally {
                // A cancelled read can settle after Promise.race has returned.
                // Its lock is still released by this attached work lifecycle.
                if (reader) {
                    try { reader.releaseLock(); } catch (cause) { recordCleanupError(cause); }
                }
            }
        };
        return await Promise.race([work(), interruption]);
    } catch (cause) {
        cancelReader();
        return fail(stopped?.code ?? stage, stopped ? stopped.cause : cause);
    } finally {
        clearTimeout(timer);
        init.signal?.removeEventListener("abort", onCallerAbort);
    }
};

/** Four workers share one deadline and one retained-response budget. No queued
 * request starts once the caller cancels or the shared deadline expires. */
export const fanOutShardRequests = async <T>(
    requests: readonly ShardRequest[], init: ShardFetchOptions = {},
): Promise<ShardCallResult<T>[]> => {
    const deadlineAtMs = Math.min(performance.now() + (init.timeoutMs ?? SHARD_FETCH_TIMEOUT_MS), init.deadlineAtMs ?? Infinity);
    const responseBudget = init.responseBudget ?? createShardResponseBudget();
    const results = new Array<ShardCallResult<T>>(requests.length);
    let next = 0;
    const run = async (): Promise<void> => {
        while (next < requests.length) {
            const index = next++;
            const request = requests[index];
            results[index] = await fetchShardJson<T>(request.shard, request.path, {
                ...init, ...request.init, deadlineAtMs, responseBudget, signal: init.signal,
            });
        }
    };
    await Promise.all(Array.from({ length: Math.min(SHARD_FANOUT_CONCURRENCY, requests.length) }, run));
    return results;
};
export const fanOutShards = async <T>(
    shards: readonly ShardEndpoint[], path: string, init: ShardFetchOptions = {},
): Promise<ShardCallResult<T>[]> => fanOutShardRequests<T>(shards.map((shard) => ({ shard, path })), init);
