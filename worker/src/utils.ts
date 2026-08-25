import { Context } from "hono";
import { createMimeMessage } from "mimetext";
import { UserSettings, RoleAddressConfig } from "./models";
import { CONSTANTS } from "./constants";
import { compressText } from "./gzip";
import { getSetting, saveSetting, getJsonSetting, deleteSetting } from './core/settings.ts';
// settings 表读写唯一实现已迁至 core/settings.ts。此处既以 named re-export 保持
// `import { getSetting, ... } from '../utils'` 调用方不变，又在 default 对象里引用同名
// import 变量（简写 `getSetting` 等价 `getSetting: getSetting`），utils.getSetting 照常可用。
export { getSetting, saveSetting, getJsonSetting, deleteSetting } from './core/settings.ts';
import { safeEqual } from './core/timing.ts';
// admin 凭据的恒定时间比较 helper 迁至 core/timing.ts（review W1-2）。此处 named import
// 供 checkIsAdmin 使用；core/timing.ts 只引 WebCrypto（crypto.subtle），node --test 可直跑。
export { safeEqual } from './core/timing.ts';

export const getJsonObjectValue = <T = any>(
    value: string | any
): T | null => {
    if (value == undefined || value == null) {
        return null;
    }
    if (typeof value === "object") {
        return value as T;
    }
    if (typeof value !== "string") {
        return null;
    }
    try {
        return JSON.parse(value) as T;
    } catch (e) {
        console.error(`GetJsonValue: Failed to parse ${value}`, e);
    }
    return null;
}

export const getStringValue = (value: any): string => {
    if (typeof value === "string") {
        return value;
    }
    return "";
}

export const getSplitStringListValue = (
    value: any, demiliter: string = ","
): string[] => {
    const valueToSplit = getStringValue(value);
    return valueToSplit.split(demiliter)
        .map((item: string) => item.trim())
        .filter((item: string) => item.length > 0);
}

export const getBooleanValue = (
    value: boolean | string | any
): boolean => {
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "string") {
        return value === "true";
    }
    return false;
}

export const getIntValue = (
    value: number | string | any,
    defaultValue: number = 0
): number => {
    if (typeof value === "number") {
        return value;
    }
    if (typeof value === "string") {
        try {
            return parseInt(value);
        } catch (e) {
            console.error(`Failed to parse int value: ${value}`);
        }
    }
    return defaultValue;
}

export const getStringArray = (
    value: string | string[] | undefined | null
): string[] => {
    if (!value) {
        return [];
    }
    // check if value is an array, if not use json.parse
    if (!Array.isArray(value)) {
        try {
            return JSON.parse(value);
        } catch (e) {
            console.error("Failed to parse value", e);
            return [];
        }
    }
    return value;
}

export const trimLower = (
    value: string | undefined | null
): string => {
    return getStringValue(value).trim().toLowerCase();
}

export const normalizeDomain = (
    value: string | undefined | null
): string => {
    return trimLower(value);
}

export const normalizeDomains = (domains: string[]): string[] => {
    return domains
        .map((domain) => normalizeDomain(domain))
        .filter((domain) => domain.length > 0);
}

export const getMailDomain = (
    value: string | undefined | null
): string => {
    const address = getStringValue(value).trim();
    const atIndex = address.lastIndexOf("@");
    if (atIndex < 0) {
        return "";
    }
    return normalizeDomain(address.slice(atIndex + 1));
}

export const normalizeAddressDomain = (
    value: string | undefined | null
): string => {
    const address = getStringValue(value).trim();
    const atIndex = address.lastIndexOf("@");
    if (atIndex < 0) {
        return address;
    }
    const localPart = address.slice(0, atIndex).trim();
    const domain = normalizeDomain(address.slice(atIndex + 1));
    if (!localPart || !domain) {
        return address;
    }
    return `${localPart}@${domain}`;
}

export const includesDomain = (
    domains: string[] | undefined | null,
    domain: string | undefined | null
): boolean => {
    const normalizedDomain = normalizeDomain(domain);
    if (!normalizedDomain || !domains || domains.length === 0) {
        return false;
    }
    return normalizeDomains(domains).includes(normalizedDomain);
}

export const isDomainOrSubdomain = (
    domain: string | undefined | null,
    allowDomain: string | undefined | null
): boolean => {
    const normalizedDomain = normalizeDomain(domain);
    const normalizedAllowDomain = normalizeDomain(allowDomain);
    if (!normalizedDomain || !normalizedAllowDomain) {
        return false;
    }
    return normalizedDomain === normalizedAllowDomain
        || normalizedDomain.endsWith(`.${normalizedAllowDomain}`);
}

export const getDomainMapValue = <T>(
    valueMap: Record<string, T> | undefined | null,
    domain: string | undefined | null
): T | null => {
    const normalizedDomain = normalizeDomain(domain);
    if (!normalizedDomain || !valueMap) {
        return null;
    }
    for (const [key, value] of Object.entries(valueMap)) {
        if (normalizeDomain(key) === normalizedDomain) {
            return value;
        }
    }
    return null;
}

export const getDefaultDomains = (c: Context<HonoCustomType>): string[] => {
    if (c.env.DEFAULT_DOMAINS == undefined || c.env.DEFAULT_DOMAINS == null) {
        return getDomains(c);
    }
    const domains = normalizeDomains(getStringArray(c.env.DEFAULT_DOMAINS));
    return domains.length > 0 ? domains : getDomains(c);
}

export const getDomains = (c: Context<HonoCustomType>): string[] => {
    if (!c.env.DOMAINS) {
        return [];
    }
    // check if DOMAINS is an array, if not use json.parse
    if (!Array.isArray(c.env.DOMAINS)) {
        try {
            return normalizeDomains(JSON.parse(c.env.DOMAINS));
        } catch (e) {
            console.error("Failed to parse DOMAINS", e);
            return [];
        }
    }
    return normalizeDomains(c.env.DOMAINS);
}

export const getRandomSubdomainDomains = (c: Context<HonoCustomType>): string[] => {
    if (!c.env.RANDOM_SUBDOMAIN_DOMAINS) {
        return [];
    }
    return normalizeDomains(getStringArray(c.env.RANDOM_SUBDOMAIN_DOMAINS));
}

export const getUserRoles = (c: Context<HonoCustomType>): UserRole[] => {
    if (!c.env.USER_ROLES) {
        return [];
    }
    const normalizeRoles = (roles: UserRole[]): UserRole[] => {
        return roles.map((role) => ({
            ...role,
            domains: Array.isArray(role.domains)
                ? normalizeDomains(role.domains)
                : typeof role.domains === "string"
                    ? normalizeDomains([role.domains])
                    : role.domains,
        }));
    };
    // check if USER_ROLES is an array, if not use json.parse
    if (!Array.isArray(c.env.USER_ROLES)) {
        try {
            return normalizeRoles(JSON.parse(c.env.USER_ROLES));
        } catch (e) {
            console.error("Failed to parse USER_ROLES", e);
            return [];
        }
    }
    return normalizeRoles(c.env.USER_ROLES);
}

export const getAnotherWorkerList = (c: Context<HonoCustomType>): AnotherWorker[] => {
    if (!c.env.ANOTHER_WORKER_LIST) {
        return [];
    }
    // check if ANOTHER_WORKER_LIST is an array, if not use json.parse
    if (!Array.isArray(c.env.ANOTHER_WORKER_LIST)) {
        try {
            return JSON.parse(c.env.ANOTHER_WORKER_LIST);
        } catch (e) {
            console.error("Failed to parse ANOTHER_WORKER_LIST", e);
            return [];
        }
    }
    return c.env.ANOTHER_WORKER_LIST;
}

export const getPasswords = (c: Context<HonoCustomType>): string[] => {
    if (!c.env.PASSWORDS) {
        return [];
    }
    // check if PASSWORDS is an array, if not use json.parse
    if (!Array.isArray(c.env.PASSWORDS)) {
        try {
            const res = JSON.parse(c.env.PASSWORDS) as string[];
            return res.filter((item) => item.length > 0);
        } catch (e) {
            console.error("Failed to parse PASSWORDS", e);
            return [];
        }
    }
    return c.env.PASSWORDS.filter((item) => item.length > 0);
}

export const getAdminPasswords = (c: Context<HonoCustomType>): string[] => {
    if (!c.env.ADMIN_PASSWORDS) {
        return [];
    }
    // check if ADMIN_PASSWORDS is an array, if not use json.parse
    if (!Array.isArray(c.env.ADMIN_PASSWORDS)) {
        try {
            const res = JSON.parse(c.env.ADMIN_PASSWORDS) as string[];
            return res.filter((item) => item.length > 0);
        } catch (e) {
            console.error("Failed to parse ADMIN_PASSWORDS", e);
            return [];
        }
    }
    return c.env.ADMIN_PASSWORDS.filter((item) => item.length > 0);
}

export const checkIsAdmin = async (c: Context<HonoCustomType>): Promise<boolean> => {
    const adminPasswords = getAdminPasswords(c);
    if (!adminPasswords.length) return false;
    const adminAuth = c.req.raw.headers.get("x-admin-auth");
    if (!adminAuth) return false;
    // review W1-2：恒定时间逐一比较 ADMIN_PASSWORDS 条目，命中即放行。
    // 顺序迭代（不排序）保持与配置顺序一致的语义。共享 admin-key 头路径
    // （聚合器 /admin/unified/* 等多工具共用）不做 IP 锁定——锁定会误伤
    // 无浏览器指纹的共享凭据调用方（见 core/timing.ts 文档注释）。
    for (const candidate of adminPasswords) {
        if (await safeEqual(candidate, adminAuth)) return true;
    }
    return false;
}

export const getEnvStringList = (value: string | string[] | undefined): string[] => {
    if (!value) {
        return [];
    }
    // check if is an array, if not use json.parse
    if (!Array.isArray(value)) {
        try {
            const res = JSON.parse(value) as string[];
            return res.filter((item) => item.length > 0);
        } catch (e) {
            console.error("Failed to parse ADMIN_PASSWORDS", e);
            return [];
        }
    }
    return value.filter((item) => item.length > 0);
}

export const sendAdminInternalMail = async (
    c: Context<HonoCustomType>, toMail: string, subject: string, text: string
): Promise<boolean> => {
    try {

        const msg = createMimeMessage();
        msg.setSender({
            name: "Admin",
            addr: "admin@internal"
        });
        msg.setRecipient(toMail);
        msg.setSubject(subject);
        msg.addMessage({
            contentType: 'text/plain',
            data: text
        });
        const message_id = Math.random().toString(36).substring(2, 15);
        const rawText = msg.asRaw();
        let success = false;
        if (getBooleanValue(c.env.ENABLE_MAIL_GZIP)) {
            let compressed: ArrayBuffer | null = null;
            try {
                compressed = await compressText(rawText);
            } catch (gzipError) {
                console.error("gzip compression failed, falling back to plaintext", gzipError);
            }
            if (compressed) {
                try {
                    ({ success } = await c.env.DB.prepare(
                        `INSERT INTO raw_mails (source, address, raw_blob, message_id) VALUES (?, ?, ?, ?)`
                    ).bind("admin@internal", toMail, compressed, message_id).run());
                } catch (dbError) {
                    const errMsg = String(dbError);
                    if (errMsg.includes('raw_blob') || errMsg.includes('no such column')) {
                        console.error("raw_blob column missing, falling back to plaintext", dbError);
                        ({ success } = await c.env.DB.prepare(
                            `INSERT INTO raw_mails (source, address, raw, message_id) VALUES (?, ?, ?, ?)`
                        ).bind("admin@internal", toMail, rawText, message_id).run());
                    } else {
                        throw dbError;
                    }
                }
            } else {
                ({ success } = await c.env.DB.prepare(
                    `INSERT INTO raw_mails (source, address, raw, message_id) VALUES (?, ?, ?, ?)`
                ).bind("admin@internal", toMail, rawText, message_id).run());
            }
        } else {
            ({ success } = await c.env.DB.prepare(
                `INSERT INTO raw_mails (source, address, raw, message_id) VALUES (?, ?, ?, ?)`
            ).bind("admin@internal", toMail, rawText, message_id).run());
        }
        if (!success) {
            console.log(`Failed save message from admin@internal to ${toMail}`);
        }
        return success;
    } catch (error) {
        console.log("sendAdminInternalMail error", error);
        return false;
    }
};

export const isGlobalTurnstileEnabled = (c: Context<HonoCustomType>): boolean => {
    return getBooleanValue(c.env.ENABLE_GLOBAL_TURNSTILE_CHECK)
        && !!c.env.CF_TURNSTILE_SITE_KEY
        && !!c.env.CF_TURNSTILE_SECRET_KEY;
}

export const checkCfTurnstile = async (
    c: Context<HonoCustomType>, token: string | undefined | null
): Promise<void> => {
    if (!c.env.CF_TURNSTILE_SITE_KEY || !c.env.CF_TURNSTILE_SECRET_KEY) {
        return;
    }
    if (!token) {
        throw new Error("Captcha token is required");
    }
    const reqIp = c.req.raw.headers.get("cf-connecting-ip");
    const formData = new FormData();
    formData.append('secret', c.env.CF_TURNSTILE_SECRET_KEY);
    formData.append('response', token);
    if (reqIp) formData.append('remoteip', reqIp);
    const url = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
    const result = await fetch(url, {
        body: formData,
        method: 'POST',
    });
    const captchaRes: any = await result.json();
    if (!captchaRes.success) {
        console.log("Captcha failed", captchaRes);
        throw new Error("Captcha failed");
    }
}

export const checkUserPassword = (password: string) => {
    if (!password || password.length < 1 || password.length > 100) {
        throw new Error("Invalid password")
    }
    return true;
}

export const hashPassword = async (password: string): Promise<string> => {
    // use crypto to hash password
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
    const hashArray = Array.from(new Uint8Array(digest));
    return hashArray.map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * KV-backed registration rate limit. Counts attempts per (action|ip) in a 60s window
 * using a TTL key holding a small counter JSON. Returns true when allowed, false when over.
 * No-op (always allows) when KV is unbound, so it can't break unrelated deploys.
 */
export const checkRegistrationRateLimit = async (
    c: Context<HonoCustomType>, action: string, limit = 5, windowSec = 60
): Promise<boolean> => {
    if (!c.env.KV) return true;
    const ip = c.req.raw.headers.get("cf-connecting-ip") || "unknown";
    const key = `reglimit|${action}|${ip}|${Math.floor(Date.now() / (windowSec * 1000))}`;
    try {
        const raw = await c.env.KV.get(key);
        const count = raw ? (parseInt(raw, 10) || 0) : 0;
        if (count >= limit) return false;
        // TTL slightly beyond the window so the key self-expires
        await c.env.KV.put(key, String(count + 1), { expirationTtl: windowSec + 5 });
        return true;
    } catch (e) {
        console.error("registration rate limit check failed", e);
        // I7b: KV 异常明确打 warn 日志（保留 fail-open——KV 宕了宁可放行注册
        // 也别锁死全站注册；真正的暴力破解面 admin 已由 admin_lockout.ts fail-closed 兜底）。
        console.warn("registration rate limit KV error (fail-open)", e);
        return true; // fail-open: don't block legit users if KV hiccups
    }
}

// 配额三函数（getMaxAddressCount / getMaxMailAccountCount / isAddressCountLimitReached）
// 已抽到 ./quota.ts —— 独立成文件便于 node --experimental-strip-types --test 直跑单测
// （utils.ts 经 gzip.ts → ./models 的 type-only 值 import 在 strip-types 下会 SyntaxError，
// quota.ts 只引纯值/类/import type，零脏依赖）。这里 re-export 保持调用方仍从 "../utils"
// 导入，无破坏。
export { getMaxAddressCount, getMaxMailAccountCount, isAddressCountLimitReached } from "./quota";

export default {
    getJsonObjectValue,
    getSetting,
    saveSetting,
    getStringValue,
    getSplitStringListValue,
    getBooleanValue,
    getIntValue,
    getStringArray,
    trimLower,
    normalizeDomain,
    normalizeDomains,
    getMailDomain,
    normalizeAddressDomain,
    includesDomain,
    getDomainMapValue,
    getDefaultDomains,
    getDomains,
    getRandomSubdomainDomains,
    getUserRoles,
    getAnotherWorkerList,
    getPasswords,
    getAdminPasswords,
    checkIsAdmin,
    getEnvStringList,
    sendAdminInternalMail,
    isGlobalTurnstileEnabled,
    checkCfTurnstile,
    checkUserPassword,
    getJsonSetting,
    getJsonValue: getJsonObjectValue,
    getStringList: getStringArray
}
