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

export type PasskeyStorage = D1Database | {
    DB?: D1Database;
    PASSKEY_CHALLENGES?: DurableObjectNamespace;
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

const challengeObject = (
    storage: PasskeyStorage,
    key: string,
): DurableObjectStub | null => {
    if (!("PASSKEY_CHALLENGES" in storage) || !storage.PASSKEY_CHALLENGES) return null;
    return storage.PASSKEY_CHALLENGES.getByName(key);
};

const callChallengeObject = async (
    stub: DurableObjectStub,
    action: "store" | "consume",
    expiresAt: number,
): Promise<boolean> => {
    const response = await stub.fetch("https://passkey-challenge.internal/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, expiresAt }),
    });
    if (response.status === 404 && action === "consume") return false;
    if (!response.ok) throw new Error(`passkey challenge store returned ${response.status}`);
    const body = await response.json<{ ok?: boolean }>();
    return body.ok === true;
};

export const storePasskeyChallenge = async (
    storage: PasskeyStorage,
    kind: PasskeyChallengeKind,
    challenge: string,
    rp: PasskeyRpContext,
    userId?: number,
    now = Date.now(),
): Promise<boolean> => {
    if (!challenge) return false;
    const db = "DB" in storage && storage.DB ? storage.DB : ("prepare" in storage ? storage as D1Database : null);
    const key = challengeKey(kind, challenge, rp, userId);
    const expiresAt = now + PASSKEY_CHALLENGE_TTL_MS;
    const object = challengeObject(storage, key);
    if (object) {
        try {
            return await callChallengeObject(object, "store", expiresAt);
        } catch (error) {
            console.error("storePasskeyChallenge authoritative store failed", error);
            return false;
        }
    }

    if (!db) return false;
    try {
        // Keep the fallback in its own indexed table. The settings table is also
        // used for unrelated configuration and must never be an auth nonce store.
        await db.prepare(
            `DELETE FROM passkey_challenges
             WHERE challenge_key IN (
                 SELECT challenge_key
                 FROM passkey_challenges
                 WHERE expires_at <= ?
                 ORDER BY expires_at
                 LIMIT 100
             )`,
        ).bind(now).run();
        const result = await db.prepare(
            `INSERT OR REPLACE INTO passkey_challenges
                (challenge_key, expires_at, created_at)
             VALUES (?, ?, ?)`,
        ).bind(key, expiresAt, now).run();
        return resultChanges(result) === 1;
    } catch (error) {
        console.error("storePasskeyChallenge DB failed", error);
        return false;
    }
};

/**
 * Atomically consume a challenge. A concurrent replay races on the same
 * row/key; exactly one consumer receives a true result.
 */
export const consumePasskeyChallenge = async (
    storage: PasskeyStorage,
    kind: PasskeyChallengeKind,
    challenge: string,
    rp: PasskeyRpContext,
    userId?: number,
    now = Date.now(),
): Promise<boolean> => {
    if (!challenge) return false;
    const db = "DB" in storage && storage.DB ? storage.DB : ("prepare" in storage ? storage as D1Database : null);
    const key = challengeKey(kind, challenge, rp, userId);
    const object = challengeObject(storage, key);
    if (object) {
        try {
            return await callChallengeObject(object, "consume", now);
        } catch (error) {
            console.error("consumePasskeyChallenge authoritative store failed", error);
            return false;
        }
    }

    if (!db) return false;
    try {
        const result = await db.prepare(
            `DELETE FROM passkey_challenges
             WHERE challenge_key = ? AND expires_at > ?`,
        ).bind(key, now).run();
        return resultChanges(result) === 1;
    } catch (error) {
        console.error("consumePasskeyChallenge DB failed", error);
        return false;
    }
};
