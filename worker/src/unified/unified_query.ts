export interface EmailFilter { where: string; params: (string | number)[]; }

export function buildEmailFilters(q: Record<string, string | undefined>): EmailFilter {
    const clauses = ["1=1"];
    const params: (string | number)[] = [];
    // source/account_id 支持逗号分隔多值（M4 readonly 多白名单注入），生成 IN 子句
    const inClause = (col: string, val: string) => {
        const parts = val.split(",").map((s) => s.trim()).filter(Boolean);
        if (parts.length === 1) { clauses.push(`${col} = ?`); params.push(parts[0]); }
        else if (parts.length > 1) { clauses.push(`${col} IN (${parts.map(() => "?").join(",")})`); params.push(...parts); }
    };
    if (q.source)      inClause("source", q.source);
    if (q.account_id)  inClause("account_id", q.account_id);
    // to_addr：用户登录后的收件人地址归属过滤（用户 JWT 通道注入），同 inClause 多值模式
    if (q.to_addr)     inClause("to_addr", q.to_addr);
    // domain：域名邮箱全域视图（cf_routing 本站邮件，收件地址以 @domain 结尾）。
    // 全域 catch-all 仅限管理员（外层 resolveScopedEmailFilter 强制校验 isAdmin/role=admin，非管理员直接 0=1 拒绝）。
    // 域名值限定合法字符集，杜绝 %/_ 等 LIKE 通配符造成全表匹配。
    if (q.domain) {
        const d = q.domain.trim().toLowerCase();
        if (!/^[a-z0-9.-]+$/.test(d) || !d.includes(".")) {
            return { where: "1=0", params: [] };
        }
        clauses.push("source = 'cf_routing'");
        clauses.push("to_addr LIKE ?");
        params.push(`%@${d}`);
    }
    if (q.unread === "1") { clauses.push("is_read = 0"); }
    else if (q.unread === "0") { clauses.push("is_read = 1"); }
    if (q.starred === "1") { clauses.push("is_starred = 1"); }
    else if (q.starred === "0") { clauses.push("(is_starred IS NULL OR is_starred = 0)"); }
    if (q.has_attachments === "1") {
        // Rows created before the attachment flag migration can still carry
        // attachment metadata while the nullable flag is absent.
        clauses.push(`(
            has_attachments = 1
            OR (
                has_attachments IS NULL
                AND CASE WHEN json_valid(attachments_json) THEN
                    CASE WHEN json_type(attachments_json) = 'array'
                        THEN json_array_length(attachments_json) > 0
                        ELSE 0
                    END
                ELSE 0 END
            )
        )`);
    }
    else if (q.has_attachments === "0") {
        clauses.push(`(
            has_attachments = 0
            OR (
                has_attachments IS NULL
                AND CASE WHEN json_valid(attachments_json) THEN
                    CASE WHEN json_type(attachments_json) = 'array'
                        THEN json_array_length(attachments_json) = 0
                        ELSE 1
                    END
                ELSE 1 END
            )
        )`);
    }
    if (q.since)       { clauses.push("received_at >= ?");  params.push(Number(q.since)); }
    if (q.until)       { clauses.push("received_at <= ?");  params.push(Number(q.until)); }
    if (q.q) {
        clauses.push("(subject LIKE ? OR from_addr LIKE ? OR text_body LIKE ?)");
        const like = `%${q.q}%`;
        params.push(like, like, like);
    }
    return { where: clauses.join(" AND "), params };
}
