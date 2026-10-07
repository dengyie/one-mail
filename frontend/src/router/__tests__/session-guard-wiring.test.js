import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const router = readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf8')

// 行为由 session_guard.test.ts 用真函数断言覆盖；这里只测"路由声明 → 守卫接线"
// 这段胶水。它用切片而不是 toContain，避免被无关排版改动误伤。
// 路由数组里每条记录的 path 固定缩进 12 空格，切片到此为止。
const ROUTE_PATH_LINE = /\n {12}path: '/

const routeBlock = (path) => {
    const at = router.indexOf(`path: '${path}'`)
    if (at === -1) return null
    const nextAt = router.slice(at + 1).search(ROUTE_PATH_LINE)
    return router.slice(at, nextAt === -1 ? router.length : at + 1 + nextAt)
}

const declaresSession = (path) => {
    const block = routeBlock(path)
    expect(block, `route ${path} should exist`).not.toBeNull()
    return /meta:\s*\{\s*requiresSession:\s*true\s*\}/.test(block)
}

const GATED = [
    '/user/addresses',
    '/user/external-accounts',
    '/user/settings',
]

describe('session guard wiring', () => {
    it('gates exactly the user-centre pages', () => {
        for (const path of GATED) {
            expect(declaresSession(path), `${path} should require a session`).toBe(true)
        }
    })

    // 回归：/sendmail、/webhook、/telegram_mail 曾被一并声明 requiresSession，
    // 把地址会话用户和 Telegram 深链用户全部弹去登录页。它们各自的鉴权主体不是
    // 用户会话，路由守卫无权过问。
    it('does not gate routes whose credential is not a user session', () => {
        for (const path of [
            '/sendmail',       // /api/sendbox → 地址 bearer
            '/webhook',        // /api/webhook/settings → 地址 bearer
            '/telegram_mail',  // /telegram/get_mail → Telegram initData
        ]) {
            expect(declaresSession(path), `${path} must stay open to non-user sessions`).toBe(false)
        }
    })

    it('leaves routes that render their own auth UI untouched', () => {
        for (const path of [
            '/user',
            '/temp-mail',
            '/user/appearance',
            '/user/oauth2/callback',
            '/domain-mailbox',
            '/unified',
            '/admin',
        ]) {
            expect(declaresSession(path), `${path} should stay open`).toBe(false)
        }
    })

    it('does not gate the redirect-only routes, which render no component', () => {
        for (const path of ['/mailbox', '/sendbox']) {
            expect(declaresSession(path), `${path} should stay open`).toBe(false)
        }
    })

    it('reads the session from the store rather than re-deriving the token', () => {
        expect(router).toContain('const { jwt, preferredLocale, hasUserSession } = useGlobalState()')
        expect(router).toContain('hasUserSession: hasUserSession.value')
    })

    it('runs after the ?jwt= handoff so a just-issued token is not bounced', () => {
        const jwtCapture = router.indexOf("hasOwnProperty.call(to.query, 'jwt')")
        const guard = router.indexOf('resolveSessionRedirect({')
        expect(jwtCapture).toBeGreaterThan(-1)
        expect(guard).toBeGreaterThan(jwtCapture)
    })

    it('runs after locale normalisation to avoid a redundant redirect hop', () => {
        const localeNormalise = router.indexOf('replaceLocaleInFullPath(to.fullPath, DEFAULT_LOCALE)')
        const guard = router.indexOf('resolveSessionRedirect({')
        expect(localeNormalise).toBeGreaterThan(-1)
        expect(guard).toBeGreaterThan(localeNormalise)
    })
})

// 上面两条清单靠人肉枚举，历史上正是"枚举时把前提想当然"让三个错误声明通过。
// 这一节从路由表本身反推：凡是声明了 requiresSession 的路由，都必须只依赖
// /user_api/*（该前缀在 worker.ts 的中间件里只认 x-user-token）。给依赖地址 bearer
// 或 Telegram initData 的页面加上守卫，这里立刻失败——清单被改错也拦得住。
describe('session guard matches the credential each page actually uses', () => {
    const componentOf = (path) => {
        const block = routeBlock(path)
        const m = block && block.match(/import\('(\.\.\/views\/[^']+)'\)/)
        expect(m, `${path} should lazy-load a view component`).toBeTruthy()
        return readFileSync(fileURLToPath(new URL(`../${m[1]}`, import.meta.url)), 'utf8')
    }

    const endpointsOf = (source) => {
        const found = new Set()
        // 覆盖 api.fetch(`/user_api/x`)、api.get('/user_api/x')、api.userMailAccounts.list()
        // 这几种写法；组件把路径写进 api 封装时，落到下一条断言兜底。
        for (const m of source.matchAll(/api(?:\.[a-zA-Z]+|\.fetch|\.get|\.post|\.put|\.delete)\(\s*[`'"]([^`'"]+)/g)) {
            found.add(m[1])
        }
        return [...found]
    }

    // 直接扫路由表，不读上面的清单——否则"改错清单"就能让断言跟着一起错。
    const declaredGatedPaths = () => {
        const paths = []
        for (const m of router.matchAll(/\n {12}path: '([^']+)'/g)) {
            const at = m.index
            const rest = router.slice(at + 1)
            const nextAt = rest.search(ROUTE_PATH_LINE)
            const block = router.slice(at, nextAt === -1 ? router.length : at + 1 + nextAt)
            if (/meta:\s*\{\s*requiresSession:\s*true\s*\}/.test(block)) paths.push(m[1])
        }
        return paths
    }

    it('finds the gated routes by scanning the router, not by trusting a list', () => {
        const found = declaredGatedPaths()
        expect(found.length).toBeGreaterThan(0)
        expect(new Set(found)).toEqual(new Set(GATED))
    })

    it('every gated route talks exclusively to /user_api', () => {
        for (const path of declaredGatedPaths()) {
            for (const endpoint of endpointsOf(componentOf(path))) {
                expect(
                    endpoint.startsWith('/user_api'),
                    `${path} calls ${endpoint}, which is not authenticated by the user session; ` +
                    'the guard would redirect credential-holders who are otherwise authorized'
                ).toBe(true)
            }
        }
    })

    it('the api wrapper behind a gated route stays inside /user_api', () => {
        // UserMailAccounts 把路径藏在 api/index.js 的 userMailAccounts 封装里，
        // 组件层扫不到；这里确认这些封装确实指向 /user_api。
        const api = readFileSync(fileURLToPath(new URL('../../api/index.js', import.meta.url)), 'utf8')
        const block = api.slice(api.indexOf('userMailAccounts: {'))
        const paths = [...block.matchAll(/siteClient\.(?:get|post|put|delete)\(\s*'([^']+)'/g)].map(m => m[1])
        expect(paths.length).toBeGreaterThan(0)
        for (const endpoint of paths) {
            expect(endpoint.startsWith('/user_api'), `${endpoint} is not /user_api`).toBe(true)
        }
    })
})
