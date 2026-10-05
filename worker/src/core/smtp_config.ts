/**
 * SMTP_CONFIG parse + fail-closed option validation.
 *
 * node --test loads this module directly, so it has zero imports.
 *
 * A domain map entry is never inherited by a subdomain. Invalid JSON or a
 * non-object payload is a configuration error, not "no SMTP". Validation
 * happens before WorkerMailer.send so a bad secret cannot become HTTP 503
 * unknown after markDispatchStarted.
 *
 * Production requires TLS. The only plaintext exemption is Mailpit-style
 * loopback on port 1025 without credentials (E2E).
 */

export class SmtpConfigError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "SmtpConfigError";
    }
}

const ALLOWED_AUTH_TYPES = new Set(["plain", "login", "cram-md5"]);
const LOOPBACK_SMTP_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "mailpit"]);
const STARTTLS_PORTS = new Set([587, 2525]);
const IMPLICIT_TLS_PORT = 465;
const MAILPIT_PORT = 1025;

const nonemptyString = (value: unknown): string | null => {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
};

const normalizeDomain = (value: string | undefined | null): string => {
    return String(value || "").trim().toLowerCase();
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return value != null && typeof value === "object" && !Array.isArray(value);
};

const isLoopbackSmtpHost = (host: string): boolean => {
    return LOOPBACK_SMTP_HOSTS.has(host.toLowerCase());
};

function throwConfig(message: string, cause?: unknown): never {
    throw new SmtpConfigError(message, cause === undefined ? undefined : { cause });
}

const domainLabel = (domain: string): string => {
    const normalized = normalizeDomain(domain);
    return normalized || "(unknown domain)";
};

/**
 * Parse SMTP_CONFIG (secret string or already-decoded object).
 * Missing / empty → no SMTP map. Anything else must be a domain→options object.
 */
export const parseSmtpConfigMap = (
    raw: unknown,
): Record<string, Record<string, unknown>> | null => {
    if (raw == null) {
        return null;
    }
    if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (trimmed.length === 0) {
            return null;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(trimmed);
        } catch (cause) {
            throwConfig("SMTP_CONFIG is not valid JSON", cause);
        }
        return assertSmtpConfigMap(parsed);
    }
    return assertSmtpConfigMap(raw);
};

const assertSmtpConfigMap = (
    value: unknown,
): Record<string, Record<string, unknown>> => {
    if (!isRecord(value)) {
        throwConfig("SMTP_CONFIG must be a JSON object keyed by sending domain");
    }
    const map: Record<string, Record<string, unknown>> = {};
    for (const [key, entry] of Object.entries(value)) {
        const domain = nonemptyString(key);
        if (!domain) {
            throwConfig("SMTP_CONFIG keys must be non-empty sending domains");
        }
        if (!isRecord(entry)) {
            throwConfig(`SMTP_CONFIG[${domain}] must be an object`);
        }
        map[domain] = entry;
    }
    return map;
};

/**
 * Exact domain match after trim+lowercase. Parent domains are not inherited.
 */
export const getSmtpConfigForDomain = (
    map: Record<string, Record<string, unknown>> | null | undefined,
    domain: string | undefined | null,
): Record<string, unknown> | null => {
    const normalizedDomain = normalizeDomain(domain);
    if (!normalizedDomain || !map) {
        return null;
    }
    for (const [key, value] of Object.entries(map)) {
        if (normalizeDomain(key) === normalizedDomain) {
            return value;
        }
    }
    return null;
};

const parseAuthTypes = (value: unknown, domain: string): string[] | undefined => {
    if (value == null) {
        return undefined;
    }
    const list = Array.isArray(value) ? value : [value];
    if (list.length === 0) {
        throwConfig(`SMTP_CONFIG[${domainLabel(domain)}].authType must not be empty`);
    }
    const types: string[] = [];
    for (const item of list) {
        if (typeof item !== "string" || !ALLOWED_AUTH_TYPES.has(item)) {
            throwConfig(
                `SMTP_CONFIG[${domainLabel(domain)}].authType must be plain, login, and/or cram-md5`,
            );
        }
        types.push(item);
    }
    return types;
};

const parseCredentials = (
    value: unknown,
    domain: string,
    required: boolean,
): { username: string; password: string } | undefined => {
    if (value == null) {
        if (required) {
            throwConfig(
                `SMTP_CONFIG[${domainLabel(domain)}] requires credentials.username and credentials.password when authType is set`,
            );
        }
        return undefined;
    }
    if (!isRecord(value)) {
        throwConfig(`SMTP_CONFIG[${domainLabel(domain)}].credentials must be an object`);
    }
    const username = nonemptyString(value.username);
    const password = nonemptyString(value.password);
    if (!username || !password) {
        throwConfig(
            `SMTP_CONFIG[${domainLabel(domain)}].credentials.username and credentials.password are required`,
        );
    }
    return { username, password };
};

const parseBooleanFlag = (
    value: unknown,
    field: "secure" | "startTls",
    domain: string,
): boolean | undefined => {
    if (value == null) {
        return undefined;
    }
    if (typeof value !== "boolean") {
        throwConfig(`SMTP_CONFIG[${domainLabel(domain)}].${field} must be a boolean`);
    }
    return value;
};

const isMailpitExemption = (input: {
    host: string;
    port: number;
    secure?: boolean;
    startTls?: boolean;
    authType?: string[];
    credentials?: { username: string; password: string };
}): boolean => {
    if (input.port !== MAILPIT_PORT) {
        return false;
    }
    if (!isLoopbackSmtpHost(input.host)) {
        return false;
    }
    if (input.secure === true || input.startTls === true) {
        return false;
    }
    if (input.authType || input.credentials) {
        return false;
    }
    return true;
};

/**
 * Validate one domain's worker-mailer options. Returns the same object if it
 * already satisfies the contract; never mutates the input.
 */
export const validateSmtpOptions = (
    domain: string,
    options: unknown,
): Record<string, unknown> => {
    if (!isRecord(options)) {
        throwConfig(`SMTP_CONFIG[${domainLabel(domain)}] must be an object`);
    }
    const host = nonemptyString(options.host);
    if (!host) {
        throwConfig(`SMTP_CONFIG[${domainLabel(domain)}].host must be a non-empty string`);
    }
    if (typeof options.port !== "number" || !Number.isSafeInteger(options.port)) {
        throwConfig(`SMTP_CONFIG[${domainLabel(domain)}].port must be a safe integer`);
    }
    const port = options.port;
    if (port < 1 || port > 65535) {
        throwConfig(`SMTP_CONFIG[${domainLabel(domain)}].port must be between 1 and 65535`);
    }
    const secure = parseBooleanFlag(options.secure, "secure", domain);
    const startTls = parseBooleanFlag(options.startTls, "startTls", domain);
    const authType = parseAuthTypes(options.authType, domain);
    const credentials = parseCredentials(options.credentials, domain, authType != null);

    const exemption = isMailpitExemption({
        host,
        port,
        secure,
        startTls,
        authType,
        credentials,
    });
    if (!exemption) {
        if (port === IMPLICIT_TLS_PORT) {
            if (secure !== true) {
                throwConfig(
                    `SMTP_CONFIG[${domainLabel(domain)}] port 465 requires secure: true`,
                );
            }
        } else if (STARTTLS_PORTS.has(port)) {
            if (startTls !== true || secure === true) {
                throwConfig(
                    `SMTP_CONFIG[${domainLabel(domain)}] port ${port} requires startTls: true and secure: false`,
                );
            }
        } else if (secure !== true && startTls !== true) {
            throwConfig(
                `SMTP_CONFIG[${domainLabel(domain)}] port ${port} requires secure: true or startTls: true`,
            );
        }
    }

    return options;
};

/**
 * Load the SMTP options for one From domain.
 * Missing map / missing domain → null (caller falls through to Resend/binding).
 * Illegal JSON or a present-but-invalid entry → SmtpConfigError.
 */
export const loadSmtpOptionsForDomain = (
    raw: unknown,
    domain: string,
): Record<string, unknown> | null => {
    const map = parseSmtpConfigMap(raw);
    const entry = getSmtpConfigForDomain(map, domain);
    if (!entry) {
        return null;
    }
    validateSmtpOptions(domain, entry);
    return entry;
};

export const isValidSmtpOptions = (options: unknown, domain = "probe"): boolean => {
    try {
        validateSmtpOptions(domain, options);
        return true;
    } catch (error) {
        if (error instanceof SmtpConfigError) {
            return false;
        }
        throw error;
    }
};
