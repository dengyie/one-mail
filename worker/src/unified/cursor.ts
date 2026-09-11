export interface EmailCursor {
    v: 1;
    sortKey: number;
    id: string;
}

const MAX_CURSOR_LENGTH = 512;
const MAX_ID_LENGTH = 256;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

const invalidCursor = (): Error => new Error("invalid cursor");

const encodeBase64Url = (value: string): string => {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
};

const decodeBase64Url = (value: string): string => {
    if (!value || value.length > MAX_CURSOR_LENGTH || !BASE64URL_RE.test(value)) {
        throw invalidCursor();
    }
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padding = (4 - (normalized.length % 4)) % 4;
    try {
        const binary = atob(normalized + "=".repeat(padding));
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        throw invalidCursor();
    }
};

const validateCursor = (cursor: unknown): EmailCursor => {
    if (!cursor || typeof cursor !== "object") throw invalidCursor();
    const raw = cursor as Partial<EmailCursor>;
    if (raw.v !== 1) throw invalidCursor();
    if (!Number.isSafeInteger(raw.sortKey)) throw invalidCursor();
    if (typeof raw.id !== "string" || raw.id.length === 0 || raw.id.length > MAX_ID_LENGTH) {
        throw invalidCursor();
    }
    return { v: 1, sortKey: raw.sortKey, id: raw.id };
};

export const encodeEmailCursor = (sortKey: number, id: string): string =>
    encodeBase64Url(JSON.stringify(validateCursor({ v: 1, sortKey, id })));

export const decodeEmailCursor = (value: string): EmailCursor => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(decodeBase64Url(value));
    } catch (error) {
        if (error instanceof Error && error.message === "invalid cursor") throw error;
        throw invalidCursor();
    }
    return validateCursor(parsed);
};

export const cursorPredicate = (cursor: EmailCursor): { sql: string; params: (string | number)[] } => ({
    sql: `(COALESCE(internal_date, received_at) < ? OR (COALESCE(internal_date, received_at) = ? AND id < ?))`,
    params: [cursor.sortKey, cursor.sortKey, cursor.id],
});
