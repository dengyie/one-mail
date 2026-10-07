// @ts-check
/** @param {unknown} subject @returns {string} */
export const extractSubjectCode = (subject) => {
  if (typeof subject !== 'string' || !subject) return ''
  // 1. 优先匹配 3+3 分隔格式（如 123-456 或 G-123456），排除电话号码
  const splitMatch = subject.match(/(?:code|验证码|verification|otp|pin|安全码|动态码|校验码|授权码|口令|passcode)[^\d]{0,24}(\b\d{3})[\s-](\d{3}\b)(?![\s-]?\d)/i)
  if (splitMatch) return splitMatch[1] + splitMatch[2]

  // 2. 匹配常见验证码前缀型（如 G-123456）
  const prefixMatch = subject.match(/\b([A-Z]-\d{4,8})\b/i)
  if (prefixMatch) return prefixMatch[1]

  // 3. 关键字邻近的 4-8 位验证码
  const kwMatch = subject.match(/(?:code|验证码|verification\s*code|otp|pin|安全码|动态码|校验码|授权码|口令|passcode)(?:\s+is)?[:：\s为是]*([0-9]{4,8}|[A-Z0-9]{5,8})(?!\d|[-/.]\d{1,2}|年)/i)
  if (kwMatch && kwMatch[1] && (/\d/.test(kwMatch[1]) || /^[A-Z]{5,8}$/.test(kwMatch[1])) && !/^(19|20)\d\d$/.test(kwMatch[1])) return kwMatch[1]

  // 4. 独立 6 位纯数字退化匹配（严谨排除年份 19xx/20xx 与订单序号/金额前缀）
  const pureNum = subject.match(/(?<![#$¥€\d])\b(\d{6})\b(?!\d)/)
  if (pureNum && !/^(19|20)\d\d$/.test(pureNum[1]) && !/(?:order|订单|no|item|ref|ticket)/i.test(subject)) {
    return pureNum[1]
  }
  return ''
}
