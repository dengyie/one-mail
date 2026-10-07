import { getPathWithLocale, splitPathSuffix, type SupportedLocale } from '../i18n/utils'

/**
 * 登录态路由守卫（纯函数）。
 *
 * 背景：`/user/*` 曾是 User.vue 内的 Tab，由 `v-if="userSettings.user_email"`
 * 兜底；提交 45506fc 把它们提升为独立路由后，beforeEach 没有任何鉴权判断，
 * 匿名访客直达 `/user/external-accounts` 会看到一个渲染完整却永远空白的表格
 * （UserMailAccounts.vue 静默跳过取数），并据此误判"邮箱丢了"。
 *
 * 这里只做纯决策，不 import vue / vue-router / store，便于在 node 环境直接单测。
 * 跳转目标复用 getPathWithLocale，保证 `/:lang/user/external-accounts` 不会
 * 被重定向成 `/zh/user`。
 */

/** 登录入口路由。 */
export const LOGIN_PATH = '/user'

export interface SessionGuardInput {
    /** 目标地址的完整路径，含 query/hash（如 `/en/user/settings?tab=a#b`）。 */
    fullPath: string
    /** 已解析的 locale，由 beforeEach 统一决定。 */
    locale: SupportedLocale
    /** 来自 route meta 的 requiresSession。 */
    requiresSession: boolean
    /** 是否持有用户会话令牌。 */
    hasUserSession: boolean
}

export type SessionGuardResult =
    | { kind: 'allow' }
    | { kind: 'redirect'; to: string }

/**
 * 需要会话但没有会话 → 重定向到登录页；其余一律放行。
 *
 * 不在这里区分"令牌过期"：过期令牌非空，守卫放行后由 siteClient 的 401
 * 自愈清凭据并跳登录（api/index.js onUnauthorized），职责单一，
 * 避免两处各自判断 token 字符串而分叉。
 */
export const resolveSessionRedirect = (input: SessionGuardInput): SessionGuardResult => {
    if (!input.requiresSession || input.hasUserSession) {
        return { kind: 'allow' }
    }
    const { suffix } = splitPathSuffix(input.fullPath)
    return { kind: 'redirect', to: `${getPathWithLocale(LOGIN_PATH, input.locale)}${suffix}` }
}
