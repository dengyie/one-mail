import { Context } from "hono";
import { canAccessRow, scopeQuery } from "./api_keys";

/**
 * 把鉴权上下文（用户登录或 API-key）翻译成 buildEmailFilters 的查询参数。
 * 用户管理员不加作用域；普通用户注入 to_addr；API-key 走 source/account 白名单。
 */
export const resolveScope = async (
    c: Context<HonoCustomType>, rest: Record<string, string | undefined>
): Promise<Record<string, string | undefined> | null> => {
    const userAuth = c.get("unifiedUserAuth");
    if (userAuth) {
        if (userAuth.isAdmin) return rest;
        if (!userAuth.toAddrScope || userAuth.toAddrScope === "__none__") return null;
        return { ...rest, to_addr: userAuth.toAddrScope };
    }
    return scopeQuery(c.get("apiKey"), rest);
};

/** 行级访问校验：用户通道按 to_addr 归属，API-key 通道走 canAccessRow。 */
export const checkRowAccess = async (
    c: Context<HonoCustomType>, row: { source?: string | null; account_id?: string | null; to_addr?: string | null }
): Promise<boolean> => {
    const userAuth = c.get("unifiedUserAuth");
    if (userAuth) {
        if (userAuth.isAdmin) return true;
        const scope = userAuth.toAddrScope;
        if (!scope || scope === "__none__" || !row.to_addr) return false;
        return scope.split(",").map((s) => s.trim()).includes(row.to_addr);
    }
    return canAccessRow(c.get("apiKey"), row.source, row.account_id);
};
