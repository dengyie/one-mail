// 项目约定：被 node --test 加载的模块只引 hono、零相对 import（本模块零 import 即可）。
// Webhook SSRF 防护（Phase 7 / I7d）：静态校验 webhook URL，拒绝私有/回环/链路本地/元数据地址。
// Workers 无 dns/net 模块，无法在 fetch 时拦截 DNS-rebinding 到私有 IP——
// 此处做 best-effort 静态校验，运行时 DNS-rebinding 仍是残留风险（见 changelog）。

const isPrivateIpv4 = (host: string): boolean => {
    // 纯数字/点分十进制 IPv4；也拦十进制整数（2130706433 = 127.0.0.1）、
    // 十六进制（0x7f.0.0.1）——所有可解析成私有 IPv4 的形式。
    // 非法数字（>255 段 / 非合法 int）不当私有处理，交由 new URL/网络层兜底。
    const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
        const parts = [m[1], m[2], m[3], m[4]].map(Number);
        if (parts.some(p => p > 255)) return false; // 非法 IP，不当私有处理
        const [a, b, ,] = parts;
        return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    }
    if (/^\d+$/.test(host)) {
        // 纯十进制整数（8.8.8.8 不打这里，只有无点整数才会）
        const n = Number(host);
        if (!Number.isFinite(n) || n < 0 || n > 4294967295) return false;
        const b3 = (n >>> 24) & 0xff;
        return b3 === 0 || b3 === 10 || b3 === 127 || (b3 === 169 && ((n >>> 16) & 0xff) === 254) || (b3 === 172 && (((n >>> 16) & 0xff) >= 16 && ((n >>> 16) & 0xff) <= 31)) || (b3 === 192 && ((n >>> 16) & 0xff) === 168);
    }
    return false;
};

const isPrivateIpv6 = (host: string): boolean => {
    // 去方括号（u.host 对 IPv6 返回带方括号形式）
    const h = host.replace(/^\[|\]$/g, "").toLowerCase();
    return h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd")
        || h.startsWith("fe80:") || h.startsWith("fe90:") || h.startsWith("fea0:") || h.startsWith("feb0:");
};

export const isSafeWebhookUrl = (urlStr: string): boolean => {
    let u;
    try { u = new URL(urlStr); } catch { return false; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    let host = u.hostname.toLowerCase();
    // 去点尾（`example.com.` 与 `example.com` 同义，防绕过）
    host = host.replace(/\.$/, "");
    if (host === "localhost") return false;
    if (host.endsWith(".local")) return false;
    if (host.endsWith(".localhost")) return false;
    if (isPrivateIpv4(host)) return false;
    if (isPrivateIpv6(u.host)) return false;   // IPv6 在 u.host 带方括号
    // I7d SSRF 加固：IPv4-mapped IPv6（::ffff:a.b.c.d）与已弃用的 IPv4-compatible IPv6
    // （::a.b.c.d）内嵌的 IPv4 若为私有地址，同样拒绝——new URL().hostname 会把 dotted-quad
    // 规范化为十六进制组（http://[::ffff:127.0.0.1] → hostname "[::ffff:7f00:1]"），
    // 故在此按规范形态重建内嵌 IPv4 并复用 isPrivateIpv4。
    // 形态：::ffff:HHHH:HHHH（mapped，最后 32 位即 IPv4）或 ::HHHH:HHHH（compat）。
    const ipv6Host = host.replace(/^\[|\]$/g, "");
    const mappedMatch = ipv6Host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    const compatMatch = ipv6Host.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    const ipv6Embedded = mappedMatch || compatMatch;
    if (ipv6Embedded) {
        const x = parseInt(ipv6Embedded[1], 16);
        const y = parseInt(ipv6Embedded[2], 16);
        const mappedIpv4 = `${x >> 8}.${x & 0xff}.${y >> 8}.${y & 0xff}`;
        if (isPrivateIpv4(mappedIpv4)) return false;
    }
    // 拦十六进制 IP（0x7f.0.0.1 等）——含 0x 的 host 一律视为可疑拒绝
    if (/0x[0-9a-f]+/i.test(host)) return false;
    // 拦「host 名字段含私有 IP + TLD」的 rebinding 帮手（如 127.0.0.1.nip.io）。
    // 保守启发：只拒点分十进制私有 IPv4 子串，公共 IP 域名（8.8.8.8.x）不受影响。
    const ipv4Candidate = host.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/);
    if (ipv4Candidate) {
        const [a, b, ,] = ipv4Candidate.slice(1).map(Number);
        if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
            return false;
        }
    }
    return true;
};