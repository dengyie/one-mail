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

const normalizeHost = (value: string): string =>
    value.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");

const isNonGlobalIpv4 = (host: string): boolean => {
    const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!match) return false;
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
        || normalized.startsWith("::ffff:127.")
        || normalized.startsWith("::ffff:10.")
        || normalized.startsWith("::ffff:192.168.")
        || normalized.startsWith("::ffff:169.254.");
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

    if (input.protocol === "imap") return true;
    if (input.pop3Host && normalizeHost(input.pop3Host) !== preset.pop3Host) return false;
    if (input.pop3Port != null && input.pop3Port !== preset.pop3Port) return false;
    return true;
};
