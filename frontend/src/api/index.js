import { useGlobalState } from '../store'
import { h } from 'vue'
import axios from 'axios'

import i18n from '../i18n'
import { getFingerprint } from '../utils/fingerprint'
import { safeBearerHeader, safeHeaderValue } from '../utils/headers'
import { sanitizeHtml } from '../utils/sanitize-html'
import { getRouterPathWithLang } from '../utils'

// 契约类型来自 @one-mail/shared（架构重构 P8）：运行时零引用，仅供 JSDoc 标注。
// ApiPath 已由 shared 导出（Task 1 定义），此处引用即可，勿重新声明。

const API_BASE = import.meta.env.VITE_API_BASE || "";

// Mail account callers historically passed a pre-serialized JSON string. Keep
// accepting that shape while ensuring axios receives an object for JSON APIs.
export const normalizeMailAccountBody = (body) => {
    if (typeof body !== 'string') return body;
    let parsed;
    try {
        parsed = JSON.parse(body);
    } catch {
        throw new Error('mail account body must be valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('mail account body must be a JSON object');
    }
    return parsed;
};
const {
    loading, auth, jwt, settings, openSettings,
    userOpenSettings, userSettings, announcement,
    showAuth, adminAuth, showAdminAuth, userJwt,
    unifiedApiKey
} = useGlobalState();

const instance = axios.create({
    baseURL: API_BASE,
    timeout: 30000,
    validateStatus: (status) => status >= 200 && status <= 500
});

// 统一请求核心（架构重构 P7）：4 个 wrapper 收敛为 1 个工厂。
// headerInjector: () => headers（每次请求调用，取 .value 现值）；
// hooks: { onRequest?, onDone?, onUnauthorized? }（loading/401 弹窗等副作用）。
const createApiClient = (headerInjector, hooks = {}) => {
    /** @param {import('@one-mail/shared').ApiPath} path 请求路径 */
    const request = async (path, options = {}) => {
        hooks.onRequest && hooks.onRequest();
        try {
            const headers = {
                'Content-Type': 'application/json',
                ...(headerInjector() || {}),
                ...(options.headers || {}),
            };
            const response = await instance.request(path, {
                method: options.method || 'GET',
                data: options.body || null,
                headers,
            });
            if (response.status === 401 && hooks.onUnauthorized) {
                hooks.onUnauthorized(response);
            }
            if (response.status >= 300) {
                const detail = response.data && typeof response.data === 'object'
                    ? response.data.error || JSON.stringify(response.data)
                    : response.data;
                throw new Error(`Code ${response.status}: ${detail || "error"}`);
            }
            return response.data;
        } finally {
            hooks.onDone && hooks.onDone();
        }
    };
    return {
        get: (p, o) => request(p, { ...o, method: 'GET' }),
        post: (p, o) => request(p, { ...o, method: 'POST' }),
        put: (p, o) => request(p, { ...o, method: 'PUT' }),
        delete: (p, o) => request(p, { ...o, method: 'DELETE' }),
        request,
    };
};

// siteClient：站点全通道（x-lang + 五个鉴权头）+ loading + 401 弹窗。
// 注：指纹异步、仅经 apiFetch 包装层注入——siteClient 不挂指纹。
const siteClient = createApiClient(() => {
    const h = { 'x-lang': i18n.global.locale.value };
    const put = (k, v) => { const s = safeHeaderValue(v); if (s) h[k] = s; };
    put('x-user-token', userJwt.value);
    put('x-user-access-token', userSettings.value.access_token);
    put('x-custom-auth', auth.value);
    put('x-admin-auth', adminAuth.value);
    const authz = safeBearerHeader(jwt.value);
    if (authz) h['Authorization'] = authz;
    return h;
}, {
    onRequest: () => { loading.value = true; },
    onDone: () => { loading.value = false; },
    onUnauthorized: (r) => {
        if (r.config.url && r.config.url.startsWith("/admin")) showAdminAuth.value = true;
        if (openSettings.value.needAuth) showAuth.value = true;
    },
});
// H6：统一收件箱统一 401 处置——清除当前通道的过期凭据（userJwt / unifiedApiKey）
// 并跳转登录页，使 unified 与会话（siteClient 的 onUnauthorized）行为一致，
// 不再静默抛 "Code 401..." 卡死。
// 用动态 import 绕开 router→views→api 的静态环；hook 在运行时才触发，模块已缓存。
const handleUnifiedUnauthorized = (r) => {
    const usedUserChannel = Boolean(r?.config?.headers?.['x-user-token']);
    if (usedUserChannel) {
        userJwt.value = '';
    } else {
        unifiedApiKey.value = '';
    }
    const locale = i18n.global.locale.value;
    import('../router').then(({ default: router }) => {
        router.push(getRouterPathWithLang('/user', locale));
    }).catch(() => {
        window.location.href = getRouterPathWithLang('/user', locale);
    });
};

// unified：Bearer API-key 单通道（不触发全局 loading）。
const unifiedClient = createApiClient(() => {
    const b = safeBearerHeader(unifiedApiKey.value);
    if (!b) throw new Error("unified api key not set");
    return { 'Authorization': b };
}, { onUnauthorized: handleUnifiedUnauthorized });
// unified user：x-user-token 单通道。
const unifiedUserClient = createApiClient(() => {
    const t = safeHeaderValue(userJwt.value);
    if (!t) throw new Error("not logged in");
    return { 'x-user-token': t };
}, { onUnauthorized: handleUnifiedUnauthorized });

const apiFetch = async (path, options = {}) => {
    loading.value = true;
    try {
        // Get browser fingerprint for request tracking
        const fingerprint = await getFingerprint();

        // Skip auth headers whose value is empty / "undefined" / contains
        // control chars (otherwise axios throws "Invalid character in header
        // content" before the request is sent — see issue #1000).
        const headers = {
            'x-lang': i18n.global.locale.value,
            'x-fingerprint': fingerprint,
            'Content-Type': 'application/json',
        };
        const put = (k, v) => { const s = safeHeaderValue(v); if (s) headers[k] = s; };
        put('x-user-token', options.userJwt || userJwt.value);
        put('x-user-access-token', userSettings.value.access_token);
        put('x-custom-auth', auth.value);
        put('x-admin-auth', adminAuth.value);
        const authz = safeBearerHeader(jwt.value);
        if (authz) headers['Authorization'] = authz;
        // 401 弹窗 / 状态码错误处理由 siteClient 的 hooks / 统一错误路径承担。
        return await siteClient.request(path, { ...options, headers });
    } finally {
        loading.value = false;
    }
}

const getOpenSettings = async (message, notification) => {
    try {
        const res = await api.fetch("/open_api/settings");
        const domains = Array.isArray(res["domains"]) ? res["domains"] : [];
        const domainLabels = res["domainLabels"] || [];
        if (domains.length < 1) {
            message.error("No domains found, please check your worker settings");
        }
        Object.assign(openSettings.value, {
            ...res,
            title: res["title"] || "",
            prefix: res["prefix"] || "",
            minAddressLen: res["minAddressLen"] || 1,
            maxAddressLen: res["maxAddressLen"] || 30,
            needAuth: res["needAuth"] || false,
            defaultDomains: res["defaultDomains"] || [],
            randomSubdomainDomains: res["randomSubdomainDomains"] || [],
            domains: domains.map((domain, index) => {
                return {
                    label: domainLabels.length > index ? domainLabels[index] : domain,
                    value: domain
                }
            }),
            adminContact: res["adminContact"] || "",
            enableUserCreateEmail: res["enableUserCreateEmail"] || false,
            disableAnonymousUserCreateEmail: res["disableAnonymousUserCreateEmail"] || false,
            disableCustomAddressName: res["disableCustomAddressName"] || false,
            enableUserDeleteEmail: res["enableUserDeleteEmail"] || false,
            enableAutoReply: res["enableAutoReply"] || false,
            enableIndexAbout: res["enableIndexAbout"] || false,
            copyright: res["copyright"] || openSettings.value.copyright,
            cfTurnstileSiteKey: res["cfTurnstileSiteKey"] || "",
            enableWebhook: res["enableWebhook"] || false,
            isS3Enabled: res["isS3Enabled"] || false,
            showGithubForUser: res["showGithubForUser"] ?? openSettings.value.showGithubForUser,
            enableAddressPassword: res["enableAddressPassword"] || false,
            enableAgentEmailInfo: res["enableAgentEmailInfo"] || false,
            smtpImapProxyConfig: res["smtpImapProxyConfig"] || openSettings.value.smtpImapProxyConfig,
            statusUrl: res["statusUrl"] || "",
            enableGlobalTurnstileCheck: res["enableGlobalTurnstileCheck"] || false,
        });
        if (openSettings.value.needAuth) {
            showAuth.value = true;
        }
        if (openSettings.value.announcement
            && !openSettings.value.fetched
            && (openSettings.value.announcement != announcement.value
                || openSettings.value.alwaysShowAnnouncement)
        ) {
            announcement.value = openSettings.value.announcement;
            notification.info({
                content: () => {
                    return h("div", {
                        innerHTML: sanitizeHtml(announcement.value)
                    });
                }
            });
        }
    } catch (error) {
        message.error(error.message || "error");
    } finally {
        openSettings.value.fetched = true;
    }
}

const autoSelectFirstBoundAddress = async () => {
    try {
        if (!userJwt.value) return;
        const res = await apiFetch('/user_api/bind_address?limit=1');
        if (res && res.results && res.results.length > 0) {
            const firstAddr = res.results[0];
            const tokenRes = await apiFetch(`/user_api/bind_address_jwt/${firstAddr.id}`);
            if (tokenRes && tokenRes.jwt) {
                jwt.value = tokenRes.jwt;
                const sRes = await apiFetch("/api/settings");
                settings.value = {
                    address: sRes["address"],
                    auto_reply: sRes["auto_reply"],
                    send_balance: sRes["send_balance"],
                };
            }
        }
    } catch (e) {
        console.warn("Auto select bound address error:", e);
    }
}

const getSettings = async () => {
    try {
        if (typeof jwt.value != 'string' || jwt.value.trim() === '' || jwt.value === 'undefined') {
            if (userJwt.value) {
                await autoSelectFirstBoundAddress();
            }
            if (typeof jwt.value != 'string' || jwt.value.trim() === '' || jwt.value === 'undefined') {
                return "";
            }
        }
        const res = await apiFetch("/api/settings");
        settings.value = {
            address: res["address"],
            auto_reply: res["auto_reply"],
            send_balance: res["send_balance"],
        };
    } catch (error) {
        console.warn("Address JWT invalid or expired, resetting address state:", error);
        jwt.value = '';
        settings.value = {
            address: '',
            auto_reply: false,
            send_balance: 0,
            fetched: true
        };
        if (userJwt.value) {
            await autoSelectFirstBoundAddress();
        }
    } finally {
        settings.value.fetched = true;
    }
}


const getUserOpenSettings = async (message) => {
    try {
        const res = await api.fetch(`/user_api/open_settings`);
        Object.assign(userOpenSettings.value, res);
    } catch (error) {
        message.error(error.message || "fetch settings failed");
    } finally {
        userOpenSettings.value.fetched = true;
    }
}

const getUserSettings = async (message) => {
    try {
        if (!userJwt.value) return;
        const res = await api.fetch("/user_api/settings")
        Object.assign(userSettings.value, res)
        // auto refresh user jwt
        if (userSettings.value.new_user_token) {
            try {
                await api.fetch("/user_api/settings", {
                    userJwt: userSettings.value.new_user_token,
                })
                userJwt.value = userSettings.value.new_user_token;
                console.log("User JWT updated successfully");
            }
            catch (error) {
                console.error("Failed to update user JWT", error);
            }
        }
    } catch (error) {
        message?.error(error.message || "error");
    } finally {
        userSettings.value.fetched = true;
    }
}

const adminShowAddressCredential = async (id) => {
    try {
        const { jwt: addressCredential } = await apiFetch(`/admin/show_password/${id}`);
        return addressCredential;
    } catch (error) {
        throw error;
    }
}

const adminDeleteAddress = async (id) => {
    try {
        await apiFetch(`/admin/delete_address/${id}`, {
            method: 'DELETE'
        });
    } catch (error) {
        throw error;
    }
}

const bindUserAddress = async () => {
    if (!userJwt.value) return;
    try {
        await apiFetch(`/user_api/bind_address`, {
            method: 'POST',
        });
    } catch (error) {
        throw error;
    }
}

// 统一收件箱 API：走 Bearer API-key，不复用站点 JWT/自定义密码头。
// 与 apiFetch 的区别：只带 Authorization: Bearer <unifiedApiKey>，不触发全局 loading。
// （无 API-key → throw "unified api key not set" 已迁进 unifiedClient 的 headerInjector。）
const unifiedFetch = (path, options = {}) => unifiedClient.request(path, options);

// 统一收件箱用户通道：浏览器登录后使用现有用户 JWT，不依赖共享 API-key。
// （未登录 → throw "not logged in" 已迁进 unifiedUserClient 的 headerInjector。）
const unifiedUserFetch = (path, options = {}) => unifiedUserClient.request(path, options);

// 登录用户优先；没有用户登录时保留 Bearer API-key 兼容路径。
const unifiedAuthFetch = (path, options = {}) =>
    safeHeaderValue(userJwt.value)
        ? unifiedUserFetch(path, options)
        : unifiedFetch(path, options);

// 构造 /api/unified/emails 的查询串：source/account_id 逗号多值、未读标记、分页、关键词。
const buildUnifiedQuery = (params = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === '') continue;
        if (Array.isArray(v)) {
            if (v.length) qs.set(k, v.join(','));
        } else {
            qs.set(k, String(v));
        }
    }
    return qs.toString();
}

export const api = {
    fetch: apiFetch,
    getSettings,
    getOpenSettings,
    getUserOpenSettings,
    getUserSettings,
    adminShowAddressCredential,
    adminDeleteAddress,
    bindUserAddress,
    unified: {
        listEmails: async (params = {}) => {
            const s = buildUnifiedQuery(params);
            return unifiedAuthFetch(`/api/unified/emails${s ? `?${s}` : ''}`);
        },
        getEmail: (id) => unifiedAuthFetch(`/api/unified/emails/${encodeURIComponent(id)}`),
        count: async (params = {}) => {
            const s = buildUnifiedQuery(params);
            return unifiedAuthFetch(`/api/unified/count${s ? `?${s}` : ''}`);
        },
        verifcodes: (addr, freshMs) =>
            unifiedAuthFetch(`/api/unified/verifcodes?addr=${encodeURIComponent(addr)}&fresh=${freshMs}`),
        markRead: (id) => unifiedAuthFetch(`/api/unified/emails/${encodeURIComponent(id)}/read`, { method: 'POST' }),
        toggleStar: (id, isStarred) =>
            unifiedAuthFetch(`/api/unified/emails/${encodeURIComponent(id)}/star`, {
                method: 'POST',
                body: typeof isStarred === 'number' ? { is_starred: isStarred } : {},
            }),
    },
    admin: {
        // 走 siteClient（即原 apiFetch 通道）：自动附带 x-admin-auth + x-user-token 等站点鉴权头。
        createUnifiedKey: (body) => siteClient.post('/admin/unified/keys', { body }),
    },
    // 用户自助接入外部邮箱归集：走 siteClient，自动附带 x-user-token
    userMailAccounts: {
        list: async () => {
            const res = await siteClient.get('/user_api/mail_accounts');
            // Rows from before protocol support are IMAP accounts. Keep the
            // response shape stable for the protocol-aware settings screen.
            return {
                ...res,
                results: (res?.results || []).map((row) => ({
                    ...row,
                    protocol: row.protocol || 'imap',
                    use_ssl: row.use_ssl ?? true,
                    pop3_ssl: row.pop3_ssl ?? true,
                    pop3_use_stls: row.pop3_use_stls ?? false,
                })),
            };
        },
        create: (body) => siteClient.post('/user_api/mail_accounts', { body: normalizeMailAccountBody(body) }),
        remove: (id) => siteClient.delete(`/user_api/mail_accounts/${encodeURIComponent(id)}`),
        toggle: (id) => siteClient.post(`/user_api/mail_accounts/${encodeURIComponent(id)}/toggle`),
    },
}
