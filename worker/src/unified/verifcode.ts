const KW_PREFIX = "(?:code|验证码|verification|otp|pin|安全码|动态码|校验码|授权码|代码|口令|passcode)";
const DATE_PATTERN = "(?:\\d{4}[-/.]\\d{1,2}(?:[-/.]\\d{1,2})?(?:\\s*\\d{1,2}:\\d{1,2}(?::\\d{1,2})?)?|\\d{4}年\\d{1,2}月(?:\\d{1,2}日)?)";
const OPTIONAL_DATE_PREFIX = "(?:[^\\d]{0,24}" + DATE_PATTERN + ")?";

// 1. 优先匹配关键词附近的 3+3 分段验证码（如 123-456 或 123 456），归一化为纯 6 位数字返回
// 使用 (?![\\s-]?\\d) 排除连续分段的电话号码（如 123-456-7890）
const SPLIT_KW_REGEX = new RegExp(
    KW_PREFIX + OPTIONAL_DATE_PREFIX + "[^\\d]{0,24}(\\b\\d{3})[\\s-](\\d{3}\\b)(?![\\s-]?\\d)",
    "i",
);

// 2. 匹配关键词附近的 4-8 位独立数字：
// 1) 允许中间跳过前置日期时间（如“验证码已于 2026-09-24 10:00:00 生成，为 8899”）
// 2) 使用 (?!\d) 防止长数字（手机号、订单号、时间戳）被截断误判
// 3) 使用 (?!\d|[-/.]\d{1,2}|年) 排除紧跟的日期格式（如 2026-09、2026/09、2026.09、2026年），避免年份误判
const KW_CODE_REGEX = new RegExp(
    KW_PREFIX + OPTIONAL_DATE_PREFIX + "[^\\d]{0,24}(\\d{4,8})(?!\\d|[-/.]\\d{1,2}|年)",
    "i",
);

// 3. 退化：任意独立的 6 位数字（6 位独立数字在通知邮件中绝大部分是 OTP）
// 注意：绝不能退化匹配无关键词的任意 4 位数字，否则邮件结尾的版权年份（如 © 2026 Google LLC）或门牌号会被严重误判
const FALLBACK_6DIGIT_REGEX = /\b(\d{6})\b/;

export function extractVerifCode(text: string): string | null {
    if (!text) return null;
    const mSplit = text.match(SPLIT_KW_REGEX);
    if (mSplit) return mSplit[1] + mSplit[2];

    const m1 = text.match(KW_CODE_REGEX);
    if (m1) return m1[1];

    const m2 = text.match(FALLBACK_6DIGIT_REGEX);
    return m2 ? m2[1] : null;
}

export interface VerifRow {
    from_addr?: unknown;
    to_addr?: unknown;
    subject?: unknown;
    received_at?: unknown;
    code?: unknown;
    source?: unknown;
}

export interface VerifAddrClause {
    clause: string;
    params: (string | number)[];
}

/**
 * 安全转义 SQL LIKE 特殊字符（% 和 _），默认转义符为反斜杠 \
 */
export function escapeSqlLike(str: string): string {
    return str.replace(/([%_\\])/g, "\\$1");
}

/**
 * 构造验证码查询的收件人地址过滤子句，安全处理通配符与域名模式
 */
export function buildVerifAddrClause(addrInput: string): VerifAddrClause {
    const addr = addrInput.trim().toLowerCase();
    if (!addr) return { clause: "", params: [] };

    // 1. @domain 后缀模式（如 @dengyie.tech）
    if (addr.startsWith("@")) {
        const domainPart = addr.slice(1);
        const escaped = escapeSqlLike(domainPart);
        return {
            clause: " AND to_addr LIKE ? ESCAPE '\\'",
            params: [`%@${escaped}`],
        };
    }

    // 2. 裸域名模式（如 dengyie.tech）
    if (!addr.includes("@") && addr.includes(".")) {
        const escaped = escapeSqlLike(addr);
        return {
            clause: " AND (to_addr = ? OR to_addr LIKE ? ESCAPE '\\')",
            params: [addr, `%@${escaped}`],
        };
    }

    // 3. 通配符模式（支持用户友好的 * 映射为 %，并对已有 % 与 _ 进行安全转义）
    if (addr.includes("*")) {
        const escaped = escapeSqlLike(addr).replace(/\*/g, "%");
        return {
            clause: " AND to_addr LIKE ? ESCAPE '\\'",
            params: [escaped],
        };
    }

    // 4. 精准单地址匹配（使用参数化全等）
    return {
        clause: " AND to_addr = ?",
        params: [addr],
    };
}

/**
 * 将 D1 数据库查询结果转换为带验证码的结构化对象列表
 */
export function mapVerifCodeRows(
    rows: Record<string, unknown>[],
    stripHtmlFn: (html: string) => string,
): VerifRow[] {
    return rows.map((r) => {
        const text = (typeof r.text_body === "string" && r.text_body.trim())
            ? r.text_body
            : stripHtmlFn(typeof r.html_body === "string" ? r.html_body : "");
        return {
            from_addr: r.from_addr,
            to_addr: r.to_addr,
            subject: r.subject,
            received_at: r.received_at,
            source: r.source,
            code: extractVerifCode(`${r.subject ?? ""}\n${text}`),
        };
    }).filter((r) => r.code);
}
