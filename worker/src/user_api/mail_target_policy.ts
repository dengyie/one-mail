type MailTargetPolicyInput = {
    source: string;
    protocol: string;
    host: string;
    port: number;
    pop3Host: string | null;
    pop3Port: number | null;
};

type PresetTarget = {
    imapHost: string;
    imapPort: number;
    pop3Host: string;
    pop3Port: number;
};

const PRESET_TARGETS: Record<string, PresetTarget> = {
    imap_gmail: {
        imapHost: "imap.gmail.com",
        imapPort: 993,
        pop3Host: "pop.gmail.com",
        pop3Port: 995,
    },
    imap_outlook: {
        imapHost: "outlook.office365.com",
        imapPort: 993,
        pop3Host: "outlook.office365.com",
        pop3Port: 995,
    },
    imap_qq: {
        imapHost: "imap.qq.com",
        imapPort: 993,
        pop3Host: "pop.qq.com",
        pop3Port: 995,
    },
    imap_163: {
        imapHost: "imap.163.com",
        imapPort: 993,
        pop3Host: "pop.163.com",
        pop3Port: 995,
    },
};

const ALLOWED_SOURCES = new Set([...Object.keys(PRESET_TARGETS), "imap_custom"]);
const ALLOWED_PROTOCOLS = new Set(["auto", "imap", "pop3"]);

const normalizeHost = (value: string): string =>
    value.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");

const parseOptionalPort = (value: unknown): number | null | undefined => {
    if (value == null || value === "") return null;
    const port = typeof value === "number" ? value : Number(value);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
};

const isNonGlobalIpv4 = (host: string): boolean => {
    const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!match) return false;
    if (match.slice(1).some((part) => part.length > 1 && part.startsWith("0"))) return true;
    const octets = match.slice(1).map(Number);
    if (octets.some((part) => part > 255)) return true;
    const [a, b, c] = octets;
    return a === 0
        || a === 10
        || a === 127
        || (a === 100 && b >= 64 && b <= 127)
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 0 && c === 0)
        || (a === 192 && b === 0 && c === 2)
        || (a === 192 && b === 168)
        || (a === 198 && (b === 18 || b === 19))
        || (a === 198 && b === 51 && c === 100)
        || (a === 203 && b === 0 && c === 113)
        || a >= 224;
};

const isNonGlobalIpv6 = (host: string): boolean => {
    if (!host.includes(":")) return false;
    const normalized = host.toLowerCase();
    return normalized === "::"
        || normalized === "::1"
        || normalized.startsWith("fc")
        || normalized.startsWith("fd")
        || /^fe[89ab][0-9a-f]:/.test(normalized)
        || normalized.startsWith("ff")
        || normalized.startsWith("2001:db8:")
        || normalized.startsWith("::ffff:");
};

/**
 * Worker-side best-effort rejection for custom mail targets. This intentionally
 * does not attempt DNS resolution; the aggregator remains authoritative for
 * rejecting DNS answers that resolve to non-global addresses.
 */
export const isSafeCustomMailHost = (value: string): boolean => {
    const host = normalizeHost(value);
    if (!host || /[\s/@\\]/.test(host)) return false;
    if (host.includes("://")) return false;
    if (host === "localhost"
        || host.endsWith(".localhost")
        || host.endsWith(".local")
        || host.endsWith(".internal")
        || host.endsWith(".lan")) {
        return false;
    }
    if (/0x[0-9a-f]+/i.test(host)) return false;
    if (/^\d+$/.test(host)) return false;
    if (/^[0-9.]+$/.test(host)
        && !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
        return false;
    }
    if (isNonGlobalIpv4(host) || isNonGlobalIpv6(host)) return false;

    const embeddedIpv4 = host.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
    if (embeddedIpv4 && isNonGlobalIpv4(embeddedIpv4[1])) return false;
    return true;
};

/**
 * Preset sources are identities, not labels for arbitrary endpoints. Exact
 * provider binding prevents a user from selecting `imap_gmail` while pointing
 * the aggregator at an internal address. `imap_custom` keeps arbitrary public
 * mail providers available, subject to the static guard above and the
 * aggregator's DNS/IP policy.
 */
export const validateMailTargetPolicy = (input: MailTargetPolicyInput): boolean => {
    if (input.source === "imap_custom") {
        if (!isSafeCustomMailHost(input.host)) return false;
        if (input.pop3Host && !isSafeCustomMailHost(input.pop3Host)) return false;
        return true;
    }

    const preset = PRESET_TARGETS[input.source];
    if (!preset) return false;
    if (normalizeHost(input.host) !== preset.imapHost || input.port !== preset.imapPort) {
        return false;
    }
    if (input.pop3Host && normalizeHost(input.pop3Host) !== preset.pop3Host) return false;
    if (input.pop3Port != null && input.pop3Port !== preset.pop3Port) return false;
    return true;
};

/**
 * Parse the public create-account request using the same compatibility shape as
 * mail_accounts.create, then apply the target policy without consuming the
 * original request body. The route calls this against Request.clone().json().
 */
export const validateMailAccountCreateTarget = (value: unknown): boolean => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const body = value as Record<string, unknown>;
    const source = typeof body.source === "string" ? body.source.trim() : "";
    const protocol = typeof body.protocol === "string" ? body.protocol.trim() : "auto";
    if (!ALLOWED_SOURCES.has(source) || !ALLOWED_PROTOCOLS.has(protocol)) return false;

    const requestedPop3Host = body.pop3_host == null
        ? null
        : typeof body.pop3_host === "string" ? body.pop3_host.trim() : undefined;
    const requestedPop3Port = parseOptionalPort(body.pop3_port);
    const requestedPort = parseOptionalPort(body.port);
    if (requestedPop3Host === undefined
        || requestedPop3Port === undefined
        || requestedPort === undefined) {
        return false;
    }

    const host = (typeof body.host === "string" ? body.host.trim() : "")
        || (protocol === "pop3" ? requestedPop3Host || "" : "");
    const port = requestedPort ?? (protocol === "pop3" ? requestedPop3Port : null);
    const pop3Host = requestedPop3Host ?? (protocol === "pop3" ? host : null);
    const pop3Port = requestedPop3Port ?? (protocol === "pop3" ? port : null);
    if (!host || port == null) return false;

    return validateMailTargetPolicy({
        source,
        protocol,
        host,
        port,
        pop3Host,
        pop3Port,
    });
};
