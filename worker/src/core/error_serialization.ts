/**
 * Error serialization for structured Worker logs.
 *
 * `JSON.stringify(new Error("boom"))` returns `{}` because `message` and
 * `stack` are non-enumerable. Passing an Error straight into `console.error`
 * therefore logs an empty object, so an unhandled handler failure reaches
 * Cloudflare tail as `error: {}` with no message and no stack. That makes a
 * 500 impossible to diagnose from logs and hides the real root cause.
 *
 * Kept dependency-free and pure so it can be unit tested under plain node.
 */

const MAX_MESSAGE = 500;
const MAX_STACK = 2000;

/** Extract a human-readable message without assuming the value is an Error. */
const messageOf = (error: unknown): string => {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    try {
        return JSON.stringify(error) ?? String(error);
    } catch {
        return String(error);
    }
};

export interface SerializedError {
    name: string;
    message: string;
    stack?: string;
    /** Present when the thrown value was not an Error but still carried a cause. */
    cause?: SerializedError;
}

/**
 * Convert an unknown thrown value into a plain object that survives
 * `JSON.stringify`, preserving the message and stack that Error instances
 * would otherwise drop.
 */
export const serializeError = (error: unknown): SerializedError => {
    if (!(error instanceof Error)) {
        return { name: 'NonError', message: messageOf(error).slice(0, MAX_MESSAGE) };
    }
    const serialized: SerializedError = {
        name: error.name || 'Error',
        message: (error.message || '').slice(0, MAX_MESSAGE),
    };
    if (error.stack) {
        serialized.stack = error.stack.slice(0, MAX_STACK);
    }
    if (error.cause !== undefined && error.cause !== null) {
        serialized.cause = serializeError(error.cause);
    }
    return serialized;
};