export function extractVerifCode(text: string): string | null {
    if (!text) return null;
    // 优先匹配关键词附近的 4-8 位独立数字：
    // 1. 使用 (?!\d) 防止长数字（手机号、订单号、时间戳）被截断误判
    // 2. 使用 (?!\d|[-/]\d{1,2}|年) 排除紧跟的日期格式（如 2026-09、2026/09、2026年），避免年份误判
    const kw = /(?:code|验证码|verification|otp|pin|安全码|动态码|校验码|授权码|代码|口令|passcode)[^\d]{0,12}(\d{4,8})(?!\d|[-/]\d{1,2}|年)/i;
    const m1 = text.match(kw);
    if (m1) return m1[1];
    // 退化：任意独立的 6 位数字（6 位独立数字在通知邮件中绝大部分是 OTP）
    // 注意：绝不能退化匹配无关键词的任意 4 位数字，否则邮件结尾的版权年份（如 © 2026 Google LLC）或门牌号会被严重误判
    const m2 = text.match(/\b(\d{6})\b/);
    return m2 ? m2[1] : null;
}