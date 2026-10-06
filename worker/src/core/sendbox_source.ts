/**
 * Sendbox source/channel tagging and list filters.
 *
 * node --test loads this module directly, so it has zero imports.
 */

export const SEND_MAIL_SOURCES = [
    "user_ui",
    "user_api",
    "external_api",
    "smtp_proxy",
    "admin",
    "admin_binding",
    "system_otp",
    "external_account",
    "unknown",
] as const;

export type SendMailSource = typeof SEND_MAIL_SOURCES[number];

export const SEND_MAIL_CHANNELS = [
    "resend",
    "smtp",
    "binding",
    "verified_binding",
] as const;

export type SendMailChannel = typeof SEND_MAIL_CHANNELS[number];

const SOURCE_SET: ReadonlySet<string> = new Set(SEND_MAIL_SOURCES);
const CHANNEL_SET: ReadonlySet<string> = new Set(SEND_MAIL_CHANNELS);

const isSendMailChannel = (value: unknown): value is SendMailChannel => {
    return typeof value === "string" && CHANNEL_SET.has(value);
};

const CLIENT_HEADER_MAP: Record<string, SendMailSource> = {
    web: "user_ui",
    "smtp-proxy": "smtp_proxy",
};

const MAX_Q_LENGTH = 80;
// eslint-disable-next-line no-control-regex
const LIKE_META_OR_CONTROL = /[%_\\]|[\u0000-\u001F\u007F]/;

const isSendMailSource = (value: unknown): value is SendMailSource => {
    return typeof value === "string" && SOURCE_SET.has(value);
};

export const resolveClientSource = (
    path: string,
    header: string | null | undefined,
): SendMailSource => {
    const mapped = typeof header === "string"
        ? CLIENT_HEADER_MAP[header.trim().toLowerCase()]
        : undefined;
    if (mapped) {
        return mapped;
    }
    if (String(path || "").includes("/external/api/send_mail")) {
        return "external_api";
    }
    return "user_api";
};

export const resolveSendMailSource = (options: {
    explicit?: SendMailSource | string | null;
    path?: string;
    header?: string | null;
}): SendMailSource => {
    if (isSendMailSource(options.explicit)) {
        return options.explicit;
    }
    return resolveClientSource(options.path || "", options.header);
};

export const persistChannelFromDispatch = (input: {
    sendByVerifiedAddressList: boolean;
    channel: { kind: string; source?: string };
}): {
    channel: SendMailChannel | null;
    channel_source?: "domain" | "global";
} => {
    if (input.sendByVerifiedAddressList) {
        return { channel: "verified_binding" };
    }
    if (input.channel.kind === "resend") {
        const source = input.channel.source === "global" ? "global" : "domain";
        return { channel: "resend", channel_source: source };
    }
    if (input.channel.kind === "smtp") {
        return { channel: "smtp" };
    }
    if (input.channel.kind === "binding") {
        return { channel: "binding" };
    }
    return { channel: null };
};

export const buildSendboxRaw = (input: {
    reqJson: Record<string, unknown>;
    geoData: unknown;
    source: SendMailSource;
    channel?: SendMailChannel | null;
    channel_source?: "domain" | "global";
    provider_message_id?: string | null;
    reservation_id?: string | number | null;
    status?: string;
}): Record<string, unknown> => {
    const body: Record<string, unknown> = {
        ...input.reqJson,
        version: "v2",
        geoData: input.geoData,
        source: input.source,
        status: input.status || "sent",
    };
    if (input.channel) {
        body.channel = input.channel;
    }
    if (input.channel_source) {
        body.channel_source = input.channel_source;
    }
    if (input.provider_message_id) {
        body.provider_message_id = input.provider_message_id;
    }
    if (input.reservation_id !== undefined && input.reservation_id !== null && input.reservation_id !== "") {
        body.reservation_id = input.reservation_id;
    }
    return body;
};

export const parseSendboxChannelParam = (
    value: string | null | undefined,
): SendMailChannel | null | undefined => {
    if (value == null) {
        return undefined;
    }
    const trimmed = String(value).trim();
    if (!trimmed) {
        return undefined;
    }
    return isSendMailChannel(trimmed) ? trimmed : null;
};

export const parseSendboxSourcesParam = (
    value: string | null | undefined,
): SendMailSource[] | null => {
    if (value == null) {
        return null;
    }
    const trimmed = String(value).trim();
    if (!trimmed) {
        return null;
    }
    const parsed = trimmed
        .split(",")
        .map((part) => part.trim())
        .filter((part) => isSendMailSource(part));
    return parsed;
};

export const sanitizeSendboxQ = (value: string | null | undefined): string | null | undefined => {
    if (value == null) {
        return undefined;
    }
    const q = String(value);
    if (!q) {
        return undefined;
    }
    if (q.length > MAX_Q_LENGTH || LIKE_META_OR_CONTROL.test(q)) {
        return null;
    }
    return q;
};

export const parseSendboxTimeBound = (value: string | number | null | undefined): string | undefined => {
    if (value == null || value === "") {
        return undefined;
    }
    if (typeof value === "number" || /^\d+$/.test(String(value).trim())) {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) {
            return undefined;
        }
        const ms = n > 1e12 ? n : n * 1000;
        const date = new Date(ms);
        if (Number.isNaN(date.getTime())) {
            return undefined;
        }
        return date.toISOString();
    }
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) {
        return undefined;
    }
    return date.toISOString();
};

const parseRawObject = (raw: unknown): Record<string, unknown> => {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        return raw as Record<string, unknown>;
    }
    if (typeof raw !== "string" || !raw) {
        return {};
    }
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
    } catch {
        return {};
    }
};

export const buildSendboxListFilter = (input: {
    address?: string | null;
    source?: string | null;
    channel?: string | null;
    q?: string | null;
    from?: string | number | null;
    to?: string | number | null;
}): {
    empty: boolean;
    where: string;
    params: unknown[];
} => {
    const sources = parseSendboxSourcesParam(input.source);
    if (Array.isArray(sources) && sources.length === 0) {
        return { empty: true, where: "1=0", params: [] };
    }
    const channel = parseSendboxChannelParam(input.channel);
    if (channel === null) {
        return { empty: true, where: "1=0", params: [] };
    }
    const q = sanitizeSendboxQ(input.q);
    if (q === null) {
        return { empty: true, where: "1=0", params: [] };
    }

    const clauses: string[] = [];
    const params: unknown[] = [];

    if (input.address) {
        clauses.push("address = ?");
        params.push(input.address);
    }

    if (sources) {
        const named = sources.filter((source) => source !== "unknown");
        const includeUnknown = sources.includes("unknown");
        const sourceClauses: string[] = [];
        if (named.length > 0) {
            sourceClauses.push(`source IN (${named.map(() => "?").join(", ")})`);
            params.push(...named);
        }
        if (includeUnknown) {
            sourceClauses.push("(source IS NULL OR source = 'unknown')");
        }
        if (sourceClauses.length > 0) {
            clauses.push(`(${sourceClauses.join(" OR ")})`);
        }
    }

    if (channel) {
        clauses.push("channel = ?");
        params.push(channel);
    }

    if (q) {
        clauses.push("(json_extract(raw, '$.subject') LIKE ? OR json_extract(raw, '$.to_mail') LIKE ?)");
        const like = `%${q}%`;
        params.push(like, like);
    }

    const fromBound = parseSendboxTimeBound(input.from ?? undefined);
    if (fromBound) {
        clauses.push("datetime(created_at) >= datetime(?)");
        params.push(fromBound);
    }
    const toBound = parseSendboxTimeBound(input.to ?? undefined);
    if (toBound) {
        clauses.push("datetime(created_at) <= datetime(?)");
        params.push(toBound);
    }

    return {
        empty: false,
        where: clauses.length > 0 ? clauses.join(" AND ") : "1=1",
        params,
    };
};

const asNonEmptyString = (value: unknown): string | null => {
    return typeof value === "string" && value ? value : null;
};

export const decorateSendboxRow = <T extends Record<string, unknown>>(row: T): T & {
    source: SendMailSource;
    channel: SendMailChannel | null;
    to_mail: unknown;
    subject: unknown;
    provider_message_id: string | null;
} => {
    const raw = parseRawObject(row.raw);
    const columnSource = row.source;
    const rawSource = raw.source;
    const source = isSendMailSource(columnSource)
        ? columnSource
        : isSendMailSource(rawSource)
            ? rawSource
            : "unknown";
    const channel = isSendMailChannel(row.channel)
        ? row.channel
        : isSendMailChannel(raw.channel)
            ? raw.channel
            : null;
    const toMail = row.to_mail ?? raw.to_mail ?? null;
    const subject = row.subject ?? raw.subject ?? null;
    const providerMessageId = asNonEmptyString(row.provider_message_id)
        ?? asNonEmptyString(raw.provider_message_id);
    return {
        ...row,
        source,
        channel,
        to_mail: toMail,
        subject,
        provider_message_id: providerMessageId,
    };
};
