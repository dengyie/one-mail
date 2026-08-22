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
    if (q.unread === "1") { clauses.push("is_read = 0"); }
    else if (q.unread === "0") { clauses.push("is_read = 1"); }
    if (q.since)       { clauses.push("received_at >= ?");  params.push(Number(q.since)); }
    if (q.until)       { clauses.push("received_at <= ?");  params.push(Number(q.until)); }
    if (q.q) {
        clauses.push("(subject LIKE ? OR from_addr LIKE ? OR text_body LIKE ?)");
        const like = `%${q.q}%`;
        params.push(like, like, like);
    }
    return { where: clauses.join(" AND "), params };
}