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

export type OutboundPayload = {
    from_addr: string;
    from_name?: string;
    to_mail: string;
    to_name?: string;
    subject: string;
    content: string;
    is_html: boolean;
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

    const content = typeof record.content === "string" ? record.content : "";
    if (!content || content.length > MAX_BODY) {
        return { ok: false, reason: "content is required and must not exceed 10 MiB" };
    }

    if (typeof record.is_html !== "boolean") {
        return { ok: false, reason: "is_html must be a boolean" };
    }

    return {
        ok: true,
        value: {
            from_addr,
            from_name: optionalName(record.from_name),
            to_mail,
            to_name: optionalName(record.to_name),
            subject,
            content,
            is_html: record.is_html,
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
