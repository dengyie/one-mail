export function extractVerifCode(text: string): string | null {
    if (!text) return null;
    // 优先匹配关键词附近的 4-8 位独立数字，使用 (?!\d) 防止长数字（手机号、订单号、时间戳）被截断误判
    const kw = /(?:code|验证码|verification|otp|pin|安全码|动态码|校验码|授权码|代码)[^\d]{0,12}(\d{4,8})(?!\d)/i;
    const m1 = text.match(kw);
    if (m1) return m1[1];
    // 退化：任意独立的 6 位数字
    const m2 = text.match(/\b(\d{6})\b/);
    if (m2) return m2[1];
    const m3 = text.match(/\b(\d{4})\b/);
    return m3 ? m3[1] : null;
}