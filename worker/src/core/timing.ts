/**
 * 恒定时间字符串比较（review W1-2：admin 凭据比较非恒定时间的修复）。
 *
 * 零外部 import、零相对 import（仅依赖 WebCrypto `crypto.subtle`，满足项目测试约束：
 * node --experimental-strip-types --test 可直跑）。
 *
 * 做法：对两串先 SHA-256（`crypto.subtle.digest`）取等长 32 字节摘要，再逐字节 XOR
 * 累积比较——天然消除不同长度的时序泄露（摘要恒等长），且不依赖平台是否提供
 * `crypto.subtle.timingSafeEqual`（Cloudflare Workers 与 Node 均无该 API，但都有
 * `crypto.subtle.digest`）。逐字节循环不提前短路，时序与内容无关。
 */
const sha256 = async (s: string): Promise<Uint8Array> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return new Uint8Array(digest);
};

export const safeEqual = async (a: string, b: string): Promise<boolean> => {
  const [da, db] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i++) {
    diff |= da[i] ^ db[i];
  }
  return diff === 0;
};