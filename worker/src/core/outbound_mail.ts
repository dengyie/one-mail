/**
 * External-account outbound mail domain: payload validation, idempotency hash,
 * and the outbound job status machine.
 *
 * node --test loads this module directly, so it has zero imports.
 *
 * An outbound job is a request to send a message *as* an external account the
 * user already connected (QQ / 163 / Gmail / Outlook / custom IMAP). Sending is
 * irreversible and un-quota'd (see docs/send-mail-external-accounts.md §5.3),
 * so the idempotency key is the plain SHA-256 of the canonical request shape
 * and the unique (account_id, request_hash) index deduplicates re-submissions.
 */

export const OUTBOUND_PROVIDERS = [
    "imap_qq",
    "imap_163",
    "imap_gmail",
    "imap_outlook",
    "graph_outlook",
    "imap_custom",
] as const;

export type OutboundProvider = (typeof OUTBOUND_PROVIDERS)[number];

export const OUTBOUND_STATUSES = [
    "pending",
    "processing",
    "succeeded",
    "failed",
    "unsupported",
    "superseded",
] as const;

export type OutboundStatus = (typeof OUTBOUND_STATUSES)[number];

const PROVIDER_SET: ReadonlySet<string> = new Set(OUTBOUND_PROVIDERS);
const STATUS_SET: ReadonlySet<string> = new Set(OUTBOUND_STATUSES);

export const isOutboundProvider = (value: unknown): value is OutboundProvider =>
    typeof value === "string" && PROVIDER_SET.has(value);

export const isOutboundStatus = (value: unknown): value is OutboundStatus =>
    typeof value === "string" && STATUS_SET.has(value);

// RFC 5321 addr-spec is at most 256 octets; 254 is the practical local+domain
// ceiling (1 for the "@", one reserved for the length-specifier comment).
const MAX_ADDRESS = 254;
// RFC 5322 recommends a 78-octet line, but subjects are commonly up to 998;
// match the existing send path's ceiling.
const MAX_SUBJECT = 998;
// Generous body ceiling (10 MiB) that still bounds memory in a Worker.
const MAX_BODY = 10 * 1024 * 1024;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** emails.id is a generated uuid; 128 octets is its practical ceiling. */
export const MAX_REPLY_TO_EMAIL_ID = 128;
/** Gmail API threadId: unpadded lowercase hex. Decimal X-GM-THRID is converted once at IMAP ingest. */
export const GMAIL_THREAD_RE = /^[0-9a-f]{1,16}$/;

export type GmailReplyOwner = { id: string; username: string };

export type GmailReplyOriginal = {
    account_id: string | null;
    source: string | null;
    provider_thread_id: string | null;
    message_id_header: string | null;
};

/**
 * A reply whose original row belongs to a sendable Gmail account is sent as
 * that account. The requested account_id is ignored. A non-Gmail original
 * returns null so the caller keeps the explicit account and drops any thread id.
 */
const singleLineHeader = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const text = value.trim();
    if (!text || /[\r\n]/.test(text)) return undefined;
    return text;
};

export const forceGmailReplyRoute = (
    original: GmailReplyOriginal | null,
    owner: GmailReplyOwner | null,
    payload: OutboundPayload,
): { accountId: string; payload: OutboundPayload } | null => {
    if (original?.source !== "imap_gmail" || !original.account_id || !owner?.id || !owner.username) {
        return null;
    }
    const stored = original.provider_thread_id?.trim().toLowerCase() ?? "";
    const threadId = GMAIL_THREAD_RE.test(stored) ? stored : undefined;
    const messageId = singleLineHeader(original.message_id_header) || singleLineHeader(payload.in_reply_to);
    const routed: OutboundPayload = {
        ...payload,
        from_addr: owner.username,
        ...(messageId ? { in_reply_to: messageId } : {}),
        ...(threadId ? { provider_thread_id: threadId } : {}),
    };
    if (!threadId) delete routed.provider_thread_id;
    return { accountId: owner.id, payload: routed };
};

export type OutboundPayload = {
    from_addr: string;
    from_name?: string;
    to_mail: string;
    to_name?: string;
    subject: string;
    content: string;
    is_html: boolean;
    in_reply_to?: string;
    references?: string[];
    /** Original emails.id. The sender uses it to recover a Gmail thread id; it is not a From. */
    reply_to_email_id?: string;
    /** Gmail API threadId (unpadded lowercase hex). Never a decimal X-GM-THRID or an RFC Message-ID. */
    provider_thread_id?: string;
};

export type OutboundValidation =
    | { ok: true; value: OutboundPayload }
    | { ok: false; reason: string };

const boundedString = (value: unknown, max: number): string | null => {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > max) {
        return null;
    }
    return trimmed;
};

const optionalName = (value: unknown): string | undefined => {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= 256 ? trimmed : undefined;
};

const toRecord = (value: unknown): Record<string, unknown> | null => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return null;
};

/**
 * Validate the client-shaped outbound send request. Never mutates input and
 * returns a reason string (not a thrown error) so the endpoint can map it to
 * a clean 400 without leaking stack details.
 */
export const validateOutboundPayload = (input: unknown): OutboundValidation => {
    const record = toRecord(input);
    if (!record) {
        return { ok: false, reason: "payload must be a JSON object" };
    }

    const from_addr = boundedString(record.from_addr, MAX_ADDRESS);
    if (!from_addr || !EMAIL_RE.test(from_addr)) {
        return { ok: false, reason: "from_addr is required and must be a valid email" };
    }

    const to_mail = boundedString(record.to_mail, MAX_ADDRESS);
    if (!to_mail || !EMAIL_RE.test(to_mail)) {
        return { ok: false, reason: "to_mail is required and must be a valid email" };
    }

    const subject = boundedString(record.subject, MAX_SUBJECT);
    if (!subject) {
        return { ok: false, reason: "subject is required" };
    }
    // A CR/LF in a header value starts another header. The senders build headers
    // with libraries that reject it (Python's EmailMessage raises ValueError), so
    // accepting it here would only turn a bad request into a job that fails
    // asynchronously. Reject it at the edge instead.
    if (/[\r\n]/.test(subject)) {
        return { ok: false, reason: "subject must be a single line" };
    }

    const content = typeof record.content === "string" ? record.content : "";
    if (!content || content.length > MAX_BODY) {
        return { ok: false, reason: "content is required and must not exceed 10 MiB" };
    }

    if (typeof record.is_html !== "boolean") {
        return { ok: false, reason: "is_html must be a boolean" };
    }

    const in_reply_to = singleLineHeader(boundedString(record.in_reply_to, 998));
    const references = Array.isArray(record.references)
        ? record.references
            .filter((v): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 998)
            .map((value) => singleLineHeader(value))
            .filter((value): value is string => Boolean(value))
        : undefined;
    const reply_to_email_id = boundedString(record.reply_to_email_id, MAX_REPLY_TO_EMAIL_ID);
    // Hex only. A long decimal X-GM-THRID is not an API threadId and must be
    // dropped here rather than converted a second time.
    const provider_thread_id = boundedString(record.provider_thread_id, 16);
    const gmailThreadId = provider_thread_id && GMAIL_THREAD_RE.test(provider_thread_id.toLowerCase())
        ? provider_thread_id.toLowerCase()
        : undefined;
    return {
        ok: true,
        value: {
            from_addr,
            // Display names are cosmetic: drop one that could break out of its
            // header instead of rejecting the whole send over it.
            from_name: singleLineHeader(optionalName(record.from_name)),
            to_mail,
            to_name: singleLineHeader(optionalName(record.to_name)),
            subject,
            content,
            is_html: record.is_html,
            ...(in_reply_to ? { in_reply_to } : {}),
            ...(references && references.length > 0 ? { references } : {}),
            ...(reply_to_email_id ? { reply_to_email_id } : {}),
            ...(gmailThreadId ? { provider_thread_id: gmailThreadId } : {}),
        },
    };
};

/**
 * Compute the idempotency key for an outbound send: SHA-256 of a canonical
 * JSON that includes the account identity and every send-relevant field. Two
 * identical re-submissions produce the same key and are deduplicated by the
 * unique index on (account_id, request_hash).
 */
export const computeOutboundRequestHash = async (input: {
    account_id: string;
    payload: OutboundPayload;
}): Promise<string> => {
    const canonical = JSON.stringify({
        account_id: input.account_id,
        from_addr: input.payload.from_addr,
        from_name: input.payload.from_name ?? "",
        to_mail: input.payload.to_mail,
        to_name: input.payload.to_name ?? "",
        subject: input.payload.subject,
        content: input.payload.content,
        is_html: input.payload.is_html,
        in_reply_to: input.payload.in_reply_to ?? "",
        references: input.payload.references ?? [],
        reply_to_email_id: input.payload.reply_to_email_id ?? "",
        provider_thread_id: input.payload.provider_thread_id ?? "",
    });
    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonical),
    );
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
};

export type OutboundJobRow = {
    id: string;
    account_id: string;
    from_addr: string;
    to_addr: string;
    subject: string;
    body_text: string | null;
    body_html: string | null;
    payload_json: string;
    request_hash: string;
    provider: string;
    status: string;
    attempts: number;
    next_attempt_at: number;
    lease_token: string | null;
    lease_until: number | null;
    provider_message_id: string | null;
    last_error: string | null;
    created_at: number;
    updated_at: number;
    completed_at: number | null;
};

/**
 * The outbound provider is derived from the connected account's `source`
 * column. Mapping lives here (single source of truth) so both the enqueue path
 * and the aggregator share the same taxonomy.
 */
export const providerForAccountSource = (source: unknown): OutboundProvider | null => {
    if (typeof source !== "string") {
        return null;
    }
    const normalized = source.trim().toLowerCase();
    return isOutboundProvider(normalized) ? normalized : null;
};
