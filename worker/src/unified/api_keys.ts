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

const inWhitelistImpl = (list: string[] | null, val?: string | null, failOnMissing = false): boolean => {
    // fail-closed：配置了白名单（list 非空）时，缺失/空的值一律拒绝。
    // 之前的 `if (!val || !list) return true` 是 fail-open——account_id 为
    // NULL 的行（getEmail 读出的 NULL source/account）会绕过 allowed_accounts
    // 作用域被 readonly key 读到（C1）。
    //
    // 单一实现二态复用（review Minor-3：合并在之前 inWhitelist /
    // inWhitelistRow 两份复制粘贴，避免逻辑漂移）：
    //   - failOnMissing=false（请求层，canAccess）：undefined → 放行，交由
    //     scopeQuery 注入白名单限定；这是 only middleware 的语义。
    //   - failOnMissing=true（行级，canAccessRow）：undefined → 拒绝。行级调用
    //     没有 scopeQuery 注入，undefined 只会是 DB NULL 值被误转，必须拒绝，
    //     否则重开 C1（review Important-2）。
    if (!list || list.length === 0) return true;
    if (val === undefined) return !failOnMissing;   // 请求层放行 / 行级拒绝
    if (!val) return false;                          // NULL / 空串：一律 fail-closed
    const parts = (val || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return false;
    // 逗号分隔多值：每个值都必须在白名单内
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

/**
 * 用户登录通道（x-user-token）的收件地址归属作用域：
 * 1) users_address JOIN address —— 该用户绑定的本站邮箱地址（mangoqwq 域 + 外部引用行）
 * 2) user_mail_accounts.username —— 该用户自助接入的外部邮箱（Part 2），即 to_addr
 * 两者 UNION 后逗号连接。无任何归属时返回哨兵 "__none__" —— 配合 buildEmailFilters
 * 的 to_addr IN (...) 会让查询返回 0 行（fail-closed），而不是返回全部邮件。
 *
 * 注意：归属以 to_addr（收件人）为准，不是 account_id（聚合器账号 id）。
 * 外部邮箱的 to_addr 直接取自 user_mail_accounts.username，不依赖 users_address 的
 * address_id UNIQUE 约束——两个用户接入同名外部邮箱时各自归属隔离，互不串看。
 */
export async function userAddressScope(db: D1Database, userId: number): Promise<string> {
    const { results } = await db.prepare(
        `SELECT a.name AS name FROM users_address ua
         JOIN address a ON a.id = ua.address_id
         WHERE ua.user_id = ?
         UNION
         SELECT username AS name FROM user_mail_accounts WHERE user_id = ? AND enabled = 1`
    ).bind(userId, userId).all<{ name: string }>();
    if (!results || results.length === 0) return "__none__";
    return results.map((r) => r.name).filter(Boolean).join(",");
}