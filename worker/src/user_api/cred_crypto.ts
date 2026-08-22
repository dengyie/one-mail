import { Context } from "hono";

// AES-GCM 可逆凭据加密（user_mail_accounts.cred_enc / oauth_enc）。
// 与 api_keys.ts 的 SHA-256 单向哈希不同：IMAP app-password / OAuth refresh_token
// 需要读回明文交给聚合器去登录外部邮箱，故必须可逆，且明文绝不落盘。
//
// 密钥取自 env MAIL_CRED_ENCRYPTION_KEY（32 字节 base64）。无密钥时一律抛错
// （fail-closed）——宁可整条归集链路失败，也不明文存储凭据。
//
// 存储格式：base64(iv || ciphertext||tag)。iv 每次加密随机生成 12 字节。

const b64encode = (bytes: Uint8Array): string =>
    btoa(String.fromCharCode(...bytes));

const b64decode = (str: string): Uint8Array => {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
};

const getKey = async (env: { MAIL_CRED_ENCRYPTION_KEY?: string }): Promise<CryptoKey> => {
    const raw = env.MAIL_CRED_ENCRYPTION_KEY;
    if (!raw) {
        throw new Error("MAIL_CRED_ENCRYPTION_KEY not set; cannot encrypt credentials");
    }
    // base64 → 32 字节
    let keyBytes: Uint8Array;
    try {
        keyBytes = b64decode(raw);
    } catch {
        throw new Error("MAIL_CRED_ENCRYPTION_KEY is not valid base64");
    }
    if (keyBytes.length !== 32) {
        throw new Error(`MAIL_CRED_ENCRYPTION_KEY must be 32 bytes, got ${keyBytes.length}`);
    }
    return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
};

export const encryptCred = async (env: { MAIL_CRED_ENCRYPTION_KEY?: string }, plain: string): Promise<string> => {
    const key = await getKey(env);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder().encode(plain);
    const cipher = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc)
    );
    const combined = new Uint8Array(iv.length + cipher.length);
    combined.set(iv, 0);
    combined.set(cipher, iv.length);
    return b64encode(combined);
};

export const decryptCred = async (env: { MAIL_CRED_ENCRYPTION_KEY?: string }, encoded: string): Promise<string> => {
    const key = await getKey(env);
    const combined = b64decode(encoded);
    if (combined.length < 13) {  // 12 iv + 至少 1 tag 字节
        throw new Error("cred_enc is too short / corrupted");
    }
    const iv = combined.slice(0, 12);
    const cipher = combined.slice(12);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
    return new TextDecoder().decode(plain);
};

/** 便捷封装：从 Context 取 env。路由处理器用这个，测试用上面的裸函数。 */
export const encryptCredCtx = async (c: Context<HonoCustomType>, plain: string): Promise<string> =>
    encryptCred(c.env, plain);
export const decryptCredCtx = async (c: Context<HonoCustomType>, encoded: string): Promise<string> =>
    decryptCred(c.env, encoded);

