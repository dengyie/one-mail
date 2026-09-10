const VERIFY_CODE_TTL_MS = 5 * 60 * 1000;
const VERIFY_CODE_PREFIX = "registration_verify_code:";
const VERIFY_CODE_RANGE = 900_000;
const UINT32_RANGE = 0x1_0000_0000;
const UINT32_ACCEPT_LIMIT = Math.floor(UINT32_RANGE / VERIFY_CODE_RANGE) * VERIFY_CODE_RANGE;

const textEncoder = new TextEncoder();

const resultChanges = (
    result: { meta?: { changes?: number } } | null | undefined,
): number => Number(result?.meta?.changes ?? 0);

const verificationKey = (email: string): string =>
    `${VERIFY_CODE_PREFIX}${encodeURIComponent(email)}`;

const digestVerificationCode = async (
    secret: string,
    email: string,
    code: string,
): Promise<string> => {
    const key = await crypto.subtle.importKey(
        "raw",
        textEncoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const digest = await crypto.subtle.sign(
        "HMAC",
        key,
        textEncoder.encode(`${email}\u0000${code}`),
    );
    return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0")
    ).join("");
};

/** Generate an unbiased six-digit code using Web Crypto. */
export const generateRegistrationVerifyCode = (): string => {
    const random = new Uint32Array(1);
    let value: number;
    do {
        crypto.getRandomValues(random);
        value = random[0];
    } while (value >= UINT32_ACCEPT_LIMIT);
    return String(100_000 + (value % VERIFY_CODE_RANGE));
};

/**
 * Reserve the one active verification-code slot for an email before sending.
 * Concurrent sends race on the settings primary key; only one INSERT succeeds.
 * The stored value contains an expiry and HMAC digest, never the plaintext code.
 */
export const reserveRegistrationVerifyCode = async (
    db: D1Database,
    secret: string,
    email: string,
    code: string,
    now = Date.now(),
): Promise<boolean> => {
    if (!secret || !email || !/^\d{6}$/.test(code)) return false;
    const key = verificationKey(email);
    const digest = await digestVerificationCode(secret, email, code);
    const expiresAt = now + VERIFY_CODE_TTL_MS;
    const storedValue = `${expiresAt}:${digest}`;
    try {
        await db.prepare(
            "DELETE FROM settings WHERE key = ? " +
            "AND CAST(substr(value, 1, instr(value, ':') - 1) AS INTEGER) <= ?"
        ).bind(key, now).run();
        const result = await db.prepare(
            "INSERT OR IGNORE INTO settings(key, value, updated_at) VALUES(?,?,datetime('now'))"
        ).bind(key, storedValue).run();
        return resultChanges(result) === 1;
    } catch {
        return false;
    }
};

/**
 * Validate then consume a code with compare-and-delete semantics. Reading the
 * row is not the security boundary: the final DELETE includes the exact value,
 * so concurrent registrations can race but only one can change a row.
 */
export const consumeRegistrationVerifyCode = async (
    db: D1Database,
    secret: string,
    email: string,
    code: string,
    now = Date.now(),
): Promise<boolean> => {
    if (!secret || !email || !/^\d{6}$/.test(code)) return false;
    const key = verificationKey(email);
    try {
        const storedValue = await db.prepare(
            "SELECT value FROM settings WHERE key = ?"
        ).bind(key).first<string>("value");
        if (!storedValue) return false;

        const separator = storedValue.indexOf(":");
        if (separator <= 0) return false;
        const expiresAt = Number(storedValue.slice(0, separator));
        const expectedDigest = storedValue.slice(separator + 1);
        if (!Number.isFinite(expiresAt) || expiresAt <= now || !expectedDigest) {
            return false;
        }

        const actualDigest = await digestVerificationCode(secret, email, code);
        if (actualDigest !== expectedDigest) return false;

        const result = await db.prepare(
            "DELETE FROM settings WHERE key = ? AND value = ?"
        ).bind(key, storedValue).run();
        return resultChanges(result) === 1;
    } catch {
        return false;
    }
};
