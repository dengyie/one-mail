const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const PASSKEY_CHALLENGE_PREFIX = "passkey_challenge:";

const DEFAULT_TRUSTED_ORIGINS = [
    "https://inbox.mangoqwq.com",
    "https://mail.mangoqwq.com",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
];

export type PasskeyChallengeKind = "register" | "authenticate";

export type PasskeyRpContext = {
    origin: string;
    rpID: string;
};

const resultChanges = (
    result: { meta?: { changes?: number } } | null | undefined,
): number => Number(result?.meta?.changes ?? 0);

const normalizeConfiguredOrigin = (value: string): string | null => {
    try {
        const url = new URL(value);
        if (url.protocol !== "https:"
            && !(url.protocol === "http:"
                && (url.hostname === "localhost" || url.hostname === "127.0.0.1"))) {
            return null;
        }
        return url.origin;
    } catch {
        return null;
    }
};

/**
 * Resolve the WebAuthn relying-party context exclusively from server-trusted
 * origins. Request-body `origin` / `domain` values are intentionally ignored.
 * FRONTEND_URL entries are exact origins after URL normalization; broad CORS
 * wildcard subdomains are not passkey trust anchors.
 */
export const resolvePasskeyRpContext = (
    originHeader: string | null,
    frontendUrl?: string,
): PasskeyRpContext | null => {
    if (!originHeader) return null;
    const normalizedOrigin = normalizeConfiguredOrigin(originHeader);
    if (!normalizedOrigin || normalizedOrigin !== originHeader.replace(/\/$/, "")) {
        return null;
    }

    const trusted = new Set(DEFAULT_TRUSTED_ORIGINS);
    for (const raw of frontendUrl?.split(",") ?? []) {
        const normalized = normalizeConfiguredOrigin(raw.trim());
        if (normalized) trusted.add(normalized);
    }
    if (!trusted.has(normalizedOrigin)) return null;

    const url = new URL(normalizedOrigin);
    return { origin: normalizedOrigin, rpID: url.hostname };
};

const challengeKey = (
    kind: PasskeyChallengeKind,
    challenge: string,
    rp: PasskeyRpContext,
    userId?: number,
): string => [
    PASSKEY_CHALLENGE_PREFIX + kind,
    encodeURIComponent(rp.origin),
    encodeURIComponent(rp.rpID),
    userId == null ? "anonymous" : String(userId),
    encodeURIComponent(challenge),
].join(":");

export const storePasskeyChallenge = async (
    db: D1Database,
    kind: PasskeyChallengeKind,
    challenge: string,
    rp: PasskeyRpContext,
    userId?: number,
    now = Date.now(),
): Promise<boolean> => {
    if (!challenge) return false;
    try {
        await db.prepare(
            "DELETE FROM settings WHERE key LIKE ? AND CAST(value AS INTEGER) <= ?"
        ).bind(`${PASSKEY_CHALLENGE_PREFIX}%`, now).run();
        const result = await db.prepare(
            "INSERT OR REPLACE INTO settings(key, value, updated_at) VALUES(?,?,datetime('now'))"
        ).bind(
            challengeKey(kind, challenge, rp, userId),
            String(now + PASSKEY_CHALLENGE_TTL_MS),
        ).run();
        return resultChanges(result) === 1;
    } catch {
        return false;
    }
};

/**
 * Atomically consume a challenge. A concurrent replay races on the same D1
 * row; exactly one DELETE can report one changed row.
 */
export const consumePasskeyChallenge = async (
    db: D1Database,
    kind: PasskeyChallengeKind,
    challenge: string,
    rp: PasskeyRpContext,
    userId?: number,
    now = Date.now(),
): Promise<boolean> => {
    if (!challenge) return false;
    try {
        const result = await db.prepare(
            "DELETE FROM settings WHERE key = ? AND CAST(value AS INTEGER) > ?"
        ).bind(challengeKey(kind, challenge, rp, userId), now).run();
        return resultChanges(result) === 1;
    } catch {
        return false;
    }
};
