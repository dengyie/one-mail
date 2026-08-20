import { Context } from "hono";

export interface ApiKeyRow {
    id: string; name: string; key_hash: string; role: string;
    allowed_sources: string | null; allowed_accounts: string | null; enabled: number;
}

export async function hashKey(key: string): Promise<string> {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function lookupKey(env: Bindings, key: string): Promise<ApiKeyRow | null> {
    const hash = await hashKey(key);
    const row = await env.DB.prepare(
        `SELECT * FROM api_keys WHERE key_hash = ? AND enabled = 1`
    ).bind(hash).first() as ApiKeyRow | null;
    if (row) {
        env.DB.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`)
            .bind(Date.now(), row.id).run().catch(() => {});
    }
    return row;
}

const parseList = (s: string | null): string[] | null => {
    if (!s) return null;
    try {
        const v: unknown = JSON.parse(s);
        if (Array.isArray(v)) return v;
        if (typeof v === "string") {
            // key_admin 可能收到逗号分隔字符串并 JSON.stringify 成带引号的字符串
            return v.split(",").map((x) => x.trim()).filter(Boolean);
        }
        return null;
    } catch { return null; }
};

const inWhitelist = (list: string[] | null, val?: string): boolean => {
    if (!val || !list) return true;
    // 逗号分隔多值：每个值都必须在白名单内
    return val.split(",").map((s) => s.trim()).filter(Boolean).every((v) => list.includes(v));
};

export function canAccess(key: Pick<ApiKeyRow, "role" | "allowed_sources" | "allowed_accounts">,
                          method: string, source?: string, accountId?: string): boolean {
    if (key.role === "admin") return true;
    if (method !== "GET") return false;
    if (!inWhitelist(parseList(key.allowed_sources), source)) return false;
    if (!inWhitelist(parseList(key.allowed_accounts), accountId)) return false;
    return true;
}

/** readonly 强制注入 source/account 白名单到查询参数（多值用逗号连接，配合 buildEmailFilters 的 IN 子句） */
export function scopeQuery(key: Pick<ApiKeyRow, "role" | "allowed_sources" | "allowed_accounts">,
                           q: Record<string, string | undefined>): Record<string, string | undefined> {
    if (key.role === "admin") return q;
    const sources = parseList(key.allowed_sources);
    const accounts = parseList(key.allowed_accounts);
    const out = { ...q };
    if (sources && sources.length > 0 && !out.source) out.source = sources.join(",");
    if (accounts && accounts.length > 0 && !out.account_id) out.account_id = accounts.join(",");
    return out;
}