/**
 * Server-side password storage and verification.
 *
 * Password endpoints now accept the user's raw password over HTTPS and store a
 * salted PBKDF2 verifier. Each record also stores a verifier for SHA-256(raw)
 * so clients from the previous frontend protocol keep working during rollout.
 * The legacy SHA-256/plaintext fallback is read-only and is upgraded after a
 * successful login.
 */
const SCHEME = "pbkdf2-sha256-v2";
const CURRENT_ITERATIONS = 120_000;
const MIN_ITERATIONS = 10_000;
const MAX_ITERATIONS = 1_000_000;
const SALT_BYTES = 16;
const DERIVED_KEY_BITS = 256;
const encoder = new TextEncoder();

const toHex = (bytes: Uint8Array): string => Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const fromHex = (value: string): Uint8Array | null => {
    if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return null;
    const bytes = new Uint8Array(value.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
};

const digest = async (value: string): Promise<Uint8Array> => {
    const result = await crypto.subtle.digest("SHA-256", encoder.encode(value));
    return new Uint8Array(result);
};

const constantTimeEqual = (left: Uint8Array, right: Uint8Array): boolean => {
    let diff = left.length ^ right.length;
    const length = Math.max(left.length, right.length);
    for (let i = 0; i < length; i += 1) {
        diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
    }
    return diff === 0;
};

const safeStringEqual = async (left: string, right: string): Promise<boolean> => {
    const [leftDigest, rightDigest] = await Promise.all([
        digest(left),
        digest(right),
    ]);
    return constantTimeEqual(leftDigest, rightDigest);
};

const derive = async (
    password: string,
    salt: Uint8Array,
    iterations: number,
): Promise<Uint8Array> => {
    const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(password),
        { name: "PBKDF2" },
        false,
        ["deriveBits"],
    );
    const result = await crypto.subtle.deriveBits(
        {
            name: "PBKDF2",
            salt: salt as unknown as BufferSource,
            iterations,
            hash: "SHA-256",
        },
        key,
        DERIVED_KEY_BITS,
    );
    return new Uint8Array(result);
};

type ParsedPasswordRecord = {
    iterations: number;
    salt: Uint8Array;
    direct: Uint8Array;
    hashed: Uint8Array;
};

const parseRecord = (stored: string): ParsedPasswordRecord | null => {
    const parts = stored.split("$");
    if (parts.length !== 5 || parts[0] !== SCHEME) return null;
    const iterations = Number(parts[1]);
    if (!Number.isInteger(iterations)
        || iterations < MIN_ITERATIONS
        || iterations > MAX_ITERATIONS) {
        return null;
    }
    const salt = fromHex(parts[2]);
    const direct = fromHex(parts[3]);
    const hashed = fromHex(parts[4]);
    if (!salt || salt.length < 8
        || !direct || direct.length !== DERIVED_KEY_BITS / 8
        || !hashed || hashed.length !== DERIVED_KEY_BITS / 8) {
        return null;
    }
    return { iterations, salt, direct, hashed };
};

export type PasswordVerification = {
    valid: boolean;
    needsRehash: boolean;
};

export const hashPasswordForStorage = async (password: string): Promise<string> => {
    if (typeof password !== "string") throw new TypeError("Password must be a string");
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const legacyInput = toHex(await digest(password));
    const [direct, hashed] = await Promise.all([
        derive(password, salt, CURRENT_ITERATIONS),
        derive(legacyInput, salt, CURRENT_ITERATIONS),
    ]);
    return [
        SCHEME,
        CURRENT_ITERATIONS,
        toHex(salt),
        toHex(direct),
        toHex(hashed),
    ].join("$");
};

export const verifyPassword = async (
    password: string,
    stored: string,
): Promise<PasswordVerification> => {
    if (typeof password !== "string" || typeof stored !== "string") {
        return { valid: false, needsRehash: false };
    }

    if (stored.startsWith(SCHEME + "$")) {
        const record = parseRecord(stored);
        if (!record) return { valid: false, needsRehash: false };
        const legacyInput = toHex(await digest(password));
        const [direct, hashed] = await Promise.all([
            derive(password, record.salt, record.iterations),
            derive(legacyInput, record.salt, record.iterations),
        ]);
        // Match both representations in both directions. This keeps a record
        // created by a legacy SHA-256 client usable after the browser switches
        // to raw passwords, and vice versa.
        const directRecordMatch = constantTimeEqual(direct, record.direct);
        const directHashedMatch = constantTimeEqual(direct, record.hashed);
        const hashedRecordMatch = constantTimeEqual(hashed, record.direct);
        const hashedHashedMatch = constantTimeEqual(hashed, record.hashed);
        const valid = directRecordMatch
            || directHashedMatch
            || hashedRecordMatch
            || hashedHashedMatch;
        return {
            valid,
            needsRehash: valid && record.iterations < CURRENT_ITERATIONS,
        };
    }

    // Existing deployments contain either a plaintext value or the old
    // frontend SHA-256 value. Read both forms once, then upgrade on login.
    const legacyInput = toHex(await digest(password));
    const [directMatch, hashedMatch] = await Promise.all([
        safeStringEqual(stored, password),
        safeStringEqual(stored, legacyInput),
    ]);
    return {
        valid: directMatch || hashedMatch,
        needsRehash: directMatch || hashedMatch,
    };
};

/**
 * Generate a random address password.  Credentials must come from a CSPRNG
 * (Web Crypto), never Math.random().
 */
export const generateRandomPassword = (): string => {
    const charset = "abcdefghijklmnopqrstuvwxyz0123456789";
    const random = new Uint32Array(8);
    crypto.getRandomValues(random);
    let password = "";
    for (let i = 0; i < 8; i++) {
        // Unbiased sampling: reject values that would skew the last bucket.
        const range = 0x100000000 - (0x100000000 % charset.length);
        let v = random[i];
        while (v >= range) {
            const buf = new Uint32Array(1);
            crypto.getRandomValues(buf);
            v = buf[0];
        }
        password += charset.charAt(v % charset.length);
    }
    return password;
};
