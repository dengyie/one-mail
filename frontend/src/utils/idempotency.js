const STORAGE_KEY_PREFIX = 'one-mail:send-mail:idempotency:';

const getStorage = () => {
    try {
        return typeof sessionStorage === 'undefined' ? null : sessionStorage;
    } catch {
        return null;
    }
};

const createRandomKey = () => {
    const cryptoApi = globalThis.crypto;
    if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
        return cryptoApi.randomUUID();
    }
    if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
        const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

export const getSendMailIdempotencyKey = (channel) => {
    const storage = getStorage();
    const storageKey = STORAGE_KEY_PREFIX + channel;
    const current = storage?.getItem(storageKey);
    if (current && current.length <= 200) return current;
    const key = createRandomKey();
    try {
        storage?.setItem(storageKey, key);
    } catch {
        // A private browsing session may reject sessionStorage; the in-memory
        // caller still reuses the key for the current component lifetime.
    }
    return key;
};

export const clearSendMailIdempotencyKey = (channel) => {
    try {
        getStorage()?.removeItem(STORAGE_KEY_PREFIX + channel);
    } catch {
        // Ignore storage cleanup failures; a future request will replace it.
    }
};
