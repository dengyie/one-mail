export const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;
// A freshly uploaded object is queued for GC before its email row is committed.
// Keep it long enough for the ingest request (and a retry after a transient
// D1/network failure) to publish the reference.
export const ATTACHMENT_GC_GRACE_MS = 60 * 60 * 1000;
export const ATTACHMENT_GC_LEASE_MS = 10 * 60 * 1000;
export const ATTACHMENT_ID_RE = /^[A-Za-z0-9._:-]{1,160}$/;
export const ATTACHMENT_KEY_RE = /^unified\/[A-Za-z0-9_-]{43}$/;

export type UnifiedAttachment = {
    id: string;
    name: string;
    size: number;
    mimeType: string;
    r2_key?: string;
};

export const safeAttachmentId = (value: unknown): value is string =>
    typeof value === "string" && ATTACHMENT_ID_RE.test(value);

export const safeAttachmentKey = (value: unknown): value is string =>
    typeof value === "string" && ATTACHMENT_KEY_RE.test(value);

export const safeAttachmentName = (value: unknown): string => {
    const input = typeof value === "string" ? value : "attachment";
    const cleaned = [...input].map((char) => {
        const code = char.codePointAt(0) ?? 0;
        return code < 0x20 || code === 0x7f || (code >= 0xd800 && code <= 0xdfff)
            || char === "\\" || char === "/" || char === "\"" ? "_" : char;
    }).join("").trim();
    return Array.from(cleaned || "attachment").slice(0, 255).join("");
};

export const safeMimeType = (value: unknown): string => {
    const input = typeof value === "string" ? value.trim() : "";
    return /^[\x20-\x7e]{1,200}$/.test(input) ? input : "application/octet-stream";
};

export const parseAttachments = (value: unknown): UnifiedAttachment[] => {
    let parsed: unknown = value;
    if (typeof value === "string") {
        try { parsed = JSON.parse(value); } catch { return []; }
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): UnifiedAttachment[] => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const row = item as Record<string, unknown>;
        if (!safeAttachmentId(row.id)) return [];
        const size = Number(row.size);
        if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ATTACHMENT_BYTES) return [];
        return [{
            id: row.id,
            name: safeAttachmentName(row.name),
            size,
            mimeType: safeMimeType(row.mimeType),
            ...(typeof row.r2_key === "string" && row.r2_key.length > 0 ? { r2_key: row.r2_key } : {}),
        }];
    });
};

export const publicAttachmentJson = (value: unknown): string => {
    let parsed: unknown = value;
    if (typeof value === "string") {
        try { parsed = JSON.parse(value); } catch { return "[]"; }
    }
    if (!Array.isArray(parsed)) return "[]";
    return JSON.stringify(parsed.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return null;
        const row = { ...(item as Record<string, unknown>) };
        const size = Number(row.size);
        const downloadable = safeAttachmentKey(row.r2_key)
            && safeAttachmentId(row.id)
            && Number.isSafeInteger(size) && size >= 0 && size <= MAX_ATTACHMENT_BYTES;
        delete row.r2_key;
        delete row._content;
        delete row._attachment_payloads;
        row.downloadable = downloadable;
        return row;
    }).filter(Boolean));
};

export const materializeAttachmentKeys = async (
    value: unknown,
    accountId: string,
    emailId: string | null,
): Promise<string> => {
    let parsed: unknown = value;
    if (typeof value === "string") {
        try { parsed = JSON.parse(value); } catch { throw new Error("invalid attachments_json"); }
    }
    if (!Array.isArray(parsed)) throw new Error("attachments_json must be an array");
    const rows = [];
    for (const item of parsed) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw new Error("invalid attachment metadata");
        }
        const row = { ...(item as Record<string, unknown>) };
        delete row.r2_key;
        delete row._content;
        delete row._attachment_payloads;
        delete row.downloadable;
        if (row.id != null && !safeAttachmentId(row.id)) throw new Error("invalid attachment id");
        if (row.name != null) row.name = safeAttachmentName(row.name);
        if (row.mimeType != null) row.mimeType = safeMimeType(row.mimeType);
        if (row.size != null) {
            const size = Number(row.size);
            if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid attachment size");
            row.size = size;
        }
        if (safeAttachmentId(row.id)) {
            if (!emailId) throw new Error("email id required for stored attachments");
            row.name = safeAttachmentName(row.name);
            row.mimeType = safeMimeType(row.mimeType);
            const size = Number(row.size);
            if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ATTACHMENT_BYTES) {
                throw new Error("invalid attachment size");
            }
            row.size = size;
            row.r2_key = await attachmentKey(accountId, emailId, row.id);
        }
        rows.push(row);
    }
    return JSON.stringify(rows);
};

export const attachmentKey = async (accountId: string, emailId: string, attachmentId: string): Promise<string> => {
    const raw = new TextEncoder().encode(`${accountId}\u0000${emailId}\u0000${attachmentId}`);
    const digest = await crypto.subtle.digest("SHA-256", raw);
    const encoded = btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    return `unified/${encoded}`;
};

export const attachmentResponseHeaders = (attachment: UnifiedAttachment): Headers => {
    const encodedName = encodeURIComponent(safeAttachmentName(attachment.name))
        .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    const headers = new Headers({
        "content-type": safeMimeType(attachment.mimeType),
        "content-disposition": `attachment; filename*=UTF-8''${encodedName}`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
    });
    if (Number.isSafeInteger(attachment.size) && attachment.size >= 0) headers.set("content-length", String(attachment.size));
    return headers;
};

export const attachmentGcInsert = async (env: Bindings, key: string): Promise<boolean> => {
    if (!env.DB) return true;
    const now = Date.now();
    const result = await env.DB.prepare(
        `INSERT INTO attachment_gc (r2_key, created_at, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(r2_key) DO UPDATE SET
           updated_at = excluded.updated_at,
           attempts = 0,
           last_error = NULL
         WHERE attachment_gc.last_error IS NOT 'gc_in_progress'
            OR attachment_gc.updated_at <= ?`,
    ).bind(key, now, now, now - ATTACHMENT_GC_LEASE_MS).run();
    return Number((result.meta as { changes?: number } | undefined)?.changes ?? 0) > 0;
};

export const releaseAttachmentGc = async (env: Bindings, keys: string[], emailIds: string[]): Promise<void> => {
    const unique = [...new Set(keys.filter(Boolean))];
    const uniqueEmailIds = [...new Set(emailIds.filter(Boolean))];
    if (!unique.length || !uniqueEmailIds.length || !env.DB) return;
    // Couple the release decision to the durable email reference in one D1
    // statement. A read followed by an unconditional delete can race retention:
    // retention may remove the row and enqueue GC between those two requests.
    await env.DB.prepare(`DELETE FROM attachment_gc
        WHERE r2_key IN (SELECT value FROM json_each(?))
          AND EXISTS (
            SELECT 1 FROM emails, json_each(
              CASE WHEN json_valid(emails.attachments_json)
                        AND json_type(emails.attachments_json) = 'array'
                   THEN emails.attachments_json ELSE '[]' END
            )
            WHERE emails.id IN (SELECT value FROM json_each(?))
              AND json_extract(json_each.value, '$.r2_key') = attachment_gc.r2_key
          )`)
        .bind(JSON.stringify(unique), JSON.stringify(uniqueEmailIds)).run();
};
