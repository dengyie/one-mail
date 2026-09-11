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

const inWhitelistImpl = (list: string[] | null, val?: string | null, failOnMissing = false): boolean => {
    // fail-closed：配置了白名单（list 非空）时，缺失/空的值一律拒绝。
    // 之前的 `if (!val || !list) return true` 是 fail-open——account_id 为
    // NULL 的行（getEmail 读出的 NULL source/account）会绕过 allowed_accounts
    // 作用域被 readonly key 读到（C1）。
    //
    // 单一实现二态复用：
    //   - failOnMissing=false（请求层，canAccess）：undefined → 放行，交由
    //     scopeQuery 注入白名单限定；这是 only middleware 的语义。
    //   - failOnMissing=true（行级，canAccessRow）：undefined → 拒绝。行级调用
    //     没有 scopeQuery 注入，undefined 只会是 DB NULL 值被误转，必须拒绝。
    if (!list || list.length === 0) return true;
    if (val === undefined) return !failOnMissing;
    if (!val) return false;
    const parts = (val || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return false;
    return parts.every((v) => list.includes(v));
};
const inWhitelist = (list: string[] | null, val?: string | null): boolean =>
    inWhitelistImpl(list, val, false);
const inWhitelistRow = (list: string[] | null, val?: string | null): boolean =>
    inWhitelistImpl(list, val, true);

export function canAccess(key: Pick<ApiKeyRow, "role" | "allowed_sources" | "allowed_accounts">,
                          method: string, source?: string | null, accountId?: string | null): boolean {
    if (key.role === "admin") return true;
    if (method !== "GET") return false;
    if (!inWhitelist(parseList(key.allowed_sources), source)) return false;
    if (!inWhitelist(parseList(key.allowed_accounts), accountId)) return false;
    return true;
}

export function canAccessRow(
    key: Pick<ApiKeyRow, "role" | "allowed_sources" | "allowed_accounts">,
    source?: string | null, accountId?: string | null): boolean {
    // 行级鉴权专用入口：永远 fail-closed。
    if (key.role === "admin") return true;
    if (!inWhitelistRow(parseList(key.allowed_sources), source)) return false;
    if (!inWhitelistRow(parseList(key.allowed_accounts), accountId)) return false;
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
