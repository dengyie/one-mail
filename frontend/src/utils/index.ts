import { getPathWithLocale } from '../i18n/utils'

export const hashPassword = async (password: string) => {
    // user crypto to hash password
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
    const hashArray = Array.from(new Uint8Array(digest));
    return hashArray.map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export const getRouterPathWithLang = (path: string, lang?: string | { value?: string }) => {
    const rawLang = typeof lang === 'object' && lang !== null && 'value' in lang
        ? (lang as { value?: string }).value
        : lang;
    const normalizedLang = rawLang === 'en'
        || rawLang === 'es'
        || rawLang === 'pt-BR'
        || rawLang === 'ja'
        || rawLang === 'de'
        ? rawLang
        : 'zh';

    return getPathWithLocale(path, normalizedLang);
}

/**
 * 列表接口的计数开关。后台轮询不需要分页总数（COUNT(*) 是 D1 rows_read 的主要
 * 消耗方），传 `withCount: false` 时返回 `&with_count=0`；缺省返回空串，不改变
 * 各端点历史「缺省即计数」的语义。
 */
export const withCountQuery = (options?: { withCount?: boolean }) =>
    options?.withCount === false ? '&with_count=0' : '';

export const utcToLocalDate = (utcDate: string, useUTCDate: boolean) => {
    const utcDateString = `${utcDate} UTC`;
    if (useUTCDate) {
        return utcDateString;
    }
    try {
        const date = new Date(utcDateString);
        // if invalid date string
        if (isNaN(date.getTime())) return utcDateString;

        return date.toLocaleString();
    } catch (e) {
        console.error(e);
    }
    return utcDateString;
}
