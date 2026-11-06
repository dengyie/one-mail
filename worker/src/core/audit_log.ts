/**
 * Admin audit trail (fail-open).
 *
 * High-risk admin operations write one immutable row per action. The audit
 * write must never decide whether the operation itself succeeds: every failure
 * path here only logs. Detail payloads are redacted and length-capped so a
 * token or password can never land in the table by accident.
 */

export const AUDIT_ACTOR_ADMIN_KEY = "admin-key";
export const AUDIT_ACTOR_ADMIN_TOKEN = "admin-token";
export const AUDIT_ACTOR_SYSTEM = "system";

const MAX_DETAIL_JSON_CHARS = 2000;
const MAX_VALUE_CHARS = 200;
const MAX_ARRAY_ITEMS = 20;
const MAX_DEPTH = 3;

// Matches whole key segments only: `token`, `api_key`, `private_key`,
// `password`, `auth`, `cookie`, `code`. `object_key` stays visible because
// ordinals like `key` inside a longer noun are not secrets.
const SENSITIVE_KEY = /(^|_)(pass|password|secret|token|code|auth|cookie|api_?key|private_?key)($|_)/i;

export type AuditEntry = {
    actor: string;
    action: string;
    targetType: string;
    targetId?: string | null;
    detail?: Record<string, unknown> | null;
    ip?: string | null;
};

type HeaderReader = {
    req: { header: (name: string) => string | undefined };
};

export function isSensitiveAuditKey(key: string): boolean {
    return SENSITIVE_KEY.test(key);
}

function sanitizeValue(value: unknown, depth: number): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") {
        return value.length > MAX_VALUE_CHARS
            ? `${value.slice(0, MAX_VALUE_CHARS)}…`
            : value;
    }
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (depth >= MAX_DEPTH) return "[truncated]";
    if (Array.isArray(value)) {
        return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, depth + 1));
    }
    if (typeof value === "object") {
        const result: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            result[key] = isSensitiveAuditKey(key) ? "[redacted]" : sanitizeValue(item, depth + 1);
        }
        return result;
    }
    return String(value);
}

/** Redacts sensitive keys and caps size. Returns a JSON string or null. */
export function sanitizeAuditDetail(
    detail: Record<string, unknown> | null | undefined,
): string | null {
    if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
    const sanitized = sanitizeValue(detail, 0);
    let json: string;
    try {
        json = JSON.stringify(sanitized);
    } catch {
        return null;
    }
    if (json.length > MAX_DETAIL_JSON_CHARS) {
        return JSON.stringify({ truncated: true, bytes: json.length });
    }
    return json;
}

/**
 * The admin surface has two credential classes: the shared `x-admin-auth`
 * password header (no per-person identity) and a role-bearing user token.
 * We record the credential class rather than the secret itself.
 */
export function resolveAuditActor(c: HeaderReader): string {
    if (c.req.header("x-admin-auth")) return AUDIT_ACTOR_ADMIN_KEY;
    if (c.req.header("x-user-access-token")) return AUDIT_ACTOR_ADMIN_TOKEN;
    return AUDIT_ACTOR_SYSTEM;
}

export function resolveAuditIp(c: HeaderReader): string | null {
    const ip = c.req.header("cf-connecting-ip")
        ?? c.req.header("x-forwarded-for")
        ?? null;
    if (!ip) return null;
    const first = ip.split(",")[0].trim();
    return first ? first.slice(0, 64) : null;
}

/**
 * Stable short fingerprint of a SQL statement. Custom-cleanup SQL can contain
 * operator-specific filters; the hash lets us correlate runs without storing
 * the statement text itself.
 */
export async function auditSqlFingerprint(sql: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sql));
    return [...new Uint8Array(digest)]
        .slice(0, 8)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

/** Never throws: a failed audit write only logs. */
export async function writeAudit(env: Pick<Bindings, "DB">, entry: AuditEntry): Promise<void> {
    try {
        await env.DB.prepare(
            `INSERT INTO audit_logs (actor, action, target_type, target_id, detail_json, ip)
             VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(
            entry.actor,
            entry.action,
            entry.targetType,
            entry.targetId ?? null,
            sanitizeAuditDetail(entry.detail),
            entry.ip ?? null,
        ).run();
    } catch (error) {
        console.error("audit log write failed", { action: entry.action, error });
    }
}
