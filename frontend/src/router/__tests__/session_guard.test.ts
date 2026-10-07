import { describe, expect, it } from 'vitest'
import { DEFAULT_LOCALE } from '../../i18n/utils'
import { LOGIN_PATH, resolveSessionRedirect, type SessionGuardInput } from '../session_guard'

const guard = (over: Partial<SessionGuardInput> = {}): SessionGuardInput => ({
    fullPath: '/user/external-accounts',
    locale: DEFAULT_LOCALE,
    requiresSession: true,
    hasUserSession: false,
    ...over,
})

describe('resolveSessionRedirect', () => {
    it('redirects a signed-out visitor away from a session-gated route', () => {
        expect(resolveSessionRedirect(guard())).toEqual({ kind: 'redirect', to: LOGIN_PATH })
    })

    it('keeps the visitor on the page once a session exists', () => {
        expect(resolveSessionRedirect(guard({ hasUserSession: true }))).toEqual({ kind: 'allow' })
    })

    it('never redirects routes that do not declare requiresSession', () => {
        // 这些路由各自有兜底：/user 是登录入口本身，/temp-mail 与
        // /user/appearance 免登录，/user/oauth2/callback 此刻才刚拿到凭据，
        // /admin/* /unified /domain-mailbox 有就地鉴权 UI。
        const publicPaths = [
            '/',
            '/user',
            '/temp-mail',
            '/user/appearance',
            '/user/oauth2/callback',
            '/admin',
            '/admin/users',
            '/unified',
            '/domain-mailbox',
        ]
        for (const fullPath of publicPaths) {
            expect(resolveSessionRedirect(guard({ fullPath, requiresSession: false })))
                .toEqual({ kind: 'allow' })
        }
    })

    it('carries the visitor locale into the login path', () => {
        expect(resolveSessionRedirect(guard({ fullPath: '/en/user/external-accounts', locale: 'en' })))
            .toEqual({ kind: 'redirect', to: '/en/user' })
        expect(resolveSessionRedirect(guard({ fullPath: '/ja/user/settings', locale: 'ja' })))
            .toEqual({ kind: 'redirect', to: '/ja/user' })
        expect(resolveSessionRedirect(guard({ fullPath: '/pt-BR/user/addresses', locale: 'pt-BR' })))
            .toEqual({ kind: 'redirect', to: '/pt-BR/user' })
    })

    it('does not redirect a locale-prefixed guest into the default locale', () => {
        // /en/user/... 的访客被送回 /user 会静默退回中文，属语言丢失。
        const result = resolveSessionRedirect(guard({ fullPath: '/en/user/external-accounts', locale: 'en' }))
        expect(result.kind).toBe('redirect')
        if (result.kind !== 'redirect') throw new Error('Expected a locale-preserving redirect')
        expect(result.to.startsWith('/zh')).toBe(false)
    })

    it('preserves the original query and hash so the deep link is not lost', () => {
        expect(resolveSessionRedirect(guard({ fullPath: '/user/settings?tab=mail#anchor', locale: 'en' })))
            .toEqual({ kind: 'redirect', to: '/en/user?tab=mail#anchor' })
        // 目标语言由守卫传入的 resolvedLocale 决定，与 fullPath 上的前缀无关：
        // fullPath 带 /en 但 locale 为 zh 时，应回到默认语言的 /user。
        expect(resolveSessionRedirect(guard({ fullPath: '/en/webhook?x=1' })))
            .toEqual({ kind: 'redirect', to: '/user?x=1' })
    })

    it('strips the locale prefix before rebuilding the login path', () => {
        // 直接传带前缀的 fullPath（守卫内部 strip），不得产出 /user/en/user。
        expect(resolveSessionRedirect(guard({ fullPath: '/de/user/webhook', locale: 'de' })))
            .toEqual({ kind: 'redirect', to: '/de/user' })
    })
})
