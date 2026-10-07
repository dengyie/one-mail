import { FleetError } from "./contracts.ts";
import { MAX_BODY_BYTES } from "./validation.ts";

/** Enforce cancellation even when an underlying fetch/stream ignores its signal. */
export async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    let rejectAbort: (reason: unknown) => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const cancel = (): void => rejectAbort(new FleetError("REGISTRY_UNAVAILABLE", 503, true, signal.reason));
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    try { return await Promise.race([operation, aborted]); }
    finally { signal.removeEventListener("abort", cancel); }
}

/** Cancellation requests may themselves stall; cleanup gets a separate bounded grace. */
async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancellation = reader.cancel().then(() => undefined, cause => cause);
    try {
        return await Promise.race([cancellation, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 25); })]);
    } finally {
        clearTimeout(timer);
    }
}

/** Reject oversized bodies while streaming, even without a Content-Length header. */
export async function readFleetJson(source: { readonly body: ReadableStream<Uint8Array> | null }, maximum = MAX_BODY_BYTES, signal?: AbortSignal): Promise<unknown> {
    if (!source.body) throw new FleetError("INVALID_REQUEST");
    const reader = source.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const reading = reader.read();
            const { done, value } = await (signal ? abortable(reading, signal) : reading);
            if (done) break;
            size += value.byteLength;
            if (size > maximum) throw new FleetError("INVALID_REQUEST", 413);
            chunks.push(value);
        }
    } catch (cause) {
        const cancellationError = await cancelReader(reader);
        if (cancellationError !== undefined) throw new FleetError("REGISTRY_UNAVAILABLE", 503, true, new AggregateError([cause, cancellationError], "fleet body read and cancellation failed"));
        throw cause;
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let position = 0;
    for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); }
    catch (cause) { throw new FleetError("INVALID_REQUEST", 400, false, cause); }
}
