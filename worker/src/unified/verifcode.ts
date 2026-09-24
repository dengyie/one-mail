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