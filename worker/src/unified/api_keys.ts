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

const inWhitelist = (list: string[] | null, val?: string | null): boolean => {
    // fail-closed：配置了白名单（list 非空）时，缺失/空的值一律拒绝。
    // 之前的 `if (!val || !list) return true` 是 fail-open——account_id 为
    // NULL 的行（如 getEmail 读出来的 NULL source/account）会绕过
    // allowed_accounts 作用域被 readonly key 读到（C1）。
    //
    // 三态语义：
    //   - undefined：请求未携带该维度参数 → 放行，交由 scopeQuery 注入白名单限定
    //   - null / 空串：显式空值（行级 NULL / 客户端显式传空）→ 拒绝
    //   - 有值：必须在白名单串（逗号分隔，每段 trim 后非空）内
    //
    // ⚠️ 只有「请求级」（middleware scopeQuery 注入后再校验）才该得到
    // `undefined` 放行。任何**行级**校验（getEmail 的行 source/account）
    // 必须走 canAccessRow，它把 undefined 也视同缺失值拒绝，防止未来
    // 调用方误把 DB 的 NULL 值转成 undefined 静默重开 C1（review Important-2）。
    if (!list || list.length === 0) return true;
    if (val === undefined) return true;         // 请求未携带该维度：放行，交由 scopeQuery 注入白名单
    if (!val) return false;                     // 显式空值 / NULL 行：fail-closed
    const parts = (val || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return false;
    // 逗号分隔多值：每个值都必须在白名单内
    return parts.every((v) => list.includes(v));
};

export function canAccess(key: Pick<ApiKeyRow, "role" | "allowed_sources" | "allowed_accounts">,
                          method: string, source?: string | null, accountId?: string | null): boolean {
    if (key.role === "admin") return true;
    if (method !== "GET") return false;
    if (!inWhitelist(parseList(key.allowed_sources), source)) return false;
    if (!inWhitelist(parseList(key.allowed_accounts), accountId)) return false;
    return true;
}

const inWhitelistRow = (list: string[] | null, val?: string | null): boolean => {
    // 行级专用：与 inWhitelist 唯一区别是「列表已配置但值缺失(undefined)」→ 拒绝，
    // 而不是放行给 scopeQuery。因为行级调用没有 scopeQuery 注入，undefined 只能
    // 是 NULL DB 值被误转（row.account_id ?? undefined / spread 默认），必须 fail-closed。
    if (!list || list.length === 0) return true;
    if (val === undefined)  return false;      // 行级缺失 → 拒绝（与请求级语义不同！）
    if (!val) return false;                    // 空 / NULL → 拒绝
    const parts = (val || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return false;
    return parts.every((v) => list.includes(v));
};

export function canAccessRow(
    key: Pick<ApiKeyRow, "role" | "allowed_sources" | "allowed_accounts">,
    source?: string | null, accountId?: string | null): boolean {
    // 行级鉴权专用入口（C1 review Important-2）：永远 fail-closed。
    // 行级调用（getEmail 对单行的 source/account 校验）必须走它，不能走
    // canAccess——后者对 undefined 放行（请求层留给 scopeQuery 注入）。
    // 若调用方把 DB NULL 行值误转成 undefined，这里也会拒绝，不会重开漏洞。
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