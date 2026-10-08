const UTC_DAY_MS = 86_400_000;
const DAILY_LIMIT = /^(?:D1_ERROR:\s*)?Your account has exceeded D1's free tier daily row (read|write) limit\./i;

export interface D1DailyQuotaFailure {
    body: {
        error: string;
        code: 'D1_DAILY_READ_LIMIT' | 'D1_DAILY_WRITE_LIMIT';
        retry_at: string;
    };
    retryAfterSeconds: number;
}

/** Recognize the platform's authoritative error, never a partial usage estimate. */
export function d1DailyQuotaFailure(error: unknown, nowMs: number): D1DailyQuotaFailure | null {
    const seen = new Set<Error>();
    let current = error;
    while (current instanceof Error && !seen.has(current) && seen.size < 16) {
        seen.add(current);
        const match = current.message.match(DAILY_LIMIT);
        if (match) {
            const reset = (Math.floor(nowMs / UTC_DAY_MS) + 1) * UTC_DAY_MS;
            const read = match[1].toLowerCase() === 'read';
            return {
                body: {
                    error: `Database daily ${read ? 'read' : 'write'} quota exhausted. Retry after the UTC reset.`,
                    code: read ? 'D1_DAILY_READ_LIMIT' : 'D1_DAILY_WRITE_LIMIT',
                    retry_at: new Date(reset).toISOString(),
                },
                retryAfterSeconds: Math.max(1, Math.ceil((reset - nowMs) / 1000)),
            };
        }
        current = current.cause;
    }
    return null;
}
