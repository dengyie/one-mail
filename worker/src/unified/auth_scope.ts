import type { Context } from "hono";
import { canAccessRow, scopeQuery } from "./api_keys";
import { buildEmailFilters, type EmailFilter } from "./unified_query";

/**
 * 普通用户的统一邮箱租户边界。
 *
 * 外部邮箱必须通过稳定 account_id 归属到 user_mail_accounts.user_id；
 * Cloudflare Email Routing 本站邮件继续通过 users_address/address 归属。
 *
 * 这里故意使用 IN(subquery) 而不是 correlated EXISTS：配合现有
 * idx_user_mail_accounts_user / idx_emails_account / idx_users_address_user_id /
 * idx_emails_to_addr，SQLite/D1 可以做 multi-index OR，避免先扫描整张 emails。
 *
 * 重要：不按 user_mail_accounts.enabled 过滤。enabled 只控制同步，用户暂停同步后
 * 仍应能读取自己的历史邮件。删除账号时现有删除流程会连同 emails 一起清理。
 *
 * 外部占位 address(source_meta='external') 不能走本站地址分支，避免重新退化成
 * “to_addr 相同就属于同一租户”的旧模型。
 */
const USER_OWNERSHIP_WHERE = `(
    emails.account_id IN (
        SELECT uma.id FROM user_mail_accounts uma
        WHERE uma.user_id = ?
    )
    OR (
        emails.source = 'cf_routing'
        AND emails.to_addr IN (
            SELECT a.name FROM users_address ua
            JOIN address a ON a.id = ua.address_id
            WHERE ua.user_id = ?
              AND (a.source_meta IS NULL OR a.source_meta != 'external')
        )
    )
)`;

/**
 * 统一构造“业务查询条件 + 鉴权作用域”。
 *
 * 用户 JWT：管理员不加租户过滤；普通用户追加 account/address ownership 集合。
 * API key：保持原来的 source/account 白名单语义。
 * 没有任何已验证鉴权上下文时 fail-closed。
 */
export const resolveScopedEmailFilter = async (
    c: Context<HonoCustomType>,
    q: Record<string, string | undefined>,
): Promise<EmailFilter> => {
    const userAuth = c.get("unifiedUserAuth");
    if (userAuth) {
        const base = buildEmailFilters(q);
        if (userAuth.isAdmin) return base;
        const userId = userAuth.userPayload?.user_id;
        if (!userId) return { where: "0=1", params: [] };
        return {
            where: `(${base.where}) AND ${USER_OWNERSHIP_WHERE}`,
            params: [...base.params, userId, userId],
        };
    }

    const key = c.get("apiKey");
    if (!key) return { where: "0=1", params: [] };
    return buildEmailFilters(scopeQuery(key, q));
};

/**
 * 单行访问校验。
 *
 * 用户通道优先按 account_id 所有权判断外部邮件；只有 cf_routing 本站邮件才允许
 * 回退到 users_address/address。API-key 通道维持原 canAccessRow 白名单语义。
 */
export const checkRowAccess = async (
    c: Context<HonoCustomType>,
    row: { source?: string | null; account_id?: string | null; to_addr?: string | null },
): Promise<boolean> => {
    const userAuth = c.get("unifiedUserAuth");
    if (userAuth) {
        if (userAuth.isAdmin) return true;
        const userId = userAuth.userPayload?.user_id;
        if (!userId) return false;

        const allowed = await c.env.DB.prepare(
            `SELECT CASE WHEN
                EXISTS (
                    SELECT 1 FROM user_mail_accounts uma
                    WHERE uma.id = ? AND uma.user_id = ?
                )
                OR (
                    ? = 'cf_routing'
                    AND EXISTS (
                        SELECT 1 FROM users_address ua
                        JOIN address a ON a.id = ua.address_id
                        WHERE ua.user_id = ?
                          AND a.name = ?
                          AND (a.source_meta IS NULL OR a.source_meta != 'external')
                    )
                )
                THEN 1 ELSE 0 END AS allowed`
        ).bind(
            row.account_id ?? "",
            userId,
            row.source ?? "",
            userId,
            row.to_addr ?? "",
        ).first<number>("allowed");
        return Number(allowed ?? 0) === 1;
    }

    const key = c.get("apiKey");
    if (!key) return false;
    return canAccessRow(key, row.source, row.account_id);
};
