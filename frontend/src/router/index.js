import { createRouter, createWebHistory } from 'vue-router'
import Home from '../views/Home.vue'
import Index from '../views/Index.vue'
import User from '../views/User.vue'
import UserOauth2Callback from '../views/user/UserOauth2Callback.vue'
import i18n from '../i18n'
import { useGlobalState } from '../store'
import {
    DEFAULT_LOCALE,
    getBrowserLocales,
    getPreferredLocale,
    LOCALE_PATH_PATTERN,
    replaceLocaleInFullPath,
    resolveMailboxRedirect,
    resolveSupportedLocale,
} from '../i18n/utils'
import { resolveSessionRedirect } from './session_guard'

const { jwt, preferredLocale, hasUserSession } = useGlobalState()

const router = createRouter({
    history: createWebHistory(),
    routes: [
        {
            path: '/',
            component: Home
        },
        {
            path: `/:lang(${LOCALE_PATH_PATTERN})`,
            alias: `/:lang(${LOCALE_PATH_PATTERN})/`,
            component: Home
        },
        {
            path: '/temp-mail',
            alias: '/temp-mail/',
            component: Index
        },
        {
            path: `/:lang(${LOCALE_PATH_PATTERN})/temp-mail`,
            alias: `/:lang(${LOCALE_PATH_PATTERN})/temp-mail/`,
            component: Index
        },
        {
            path: '/mailbox',
            alias: '/mailbox/',
            redirect: (to) => {
                const target = resolveMailboxRedirect(to.fullPath)
                if (!target) {
                    return { name: 'not-found' }
                }
                return target
            },
        },
        {
            path: `/:lang(${LOCALE_PATH_PATTERN})/mailbox`,
            alias: `/:lang(${LOCALE_PATH_PATTERN})/mailbox/`,
            redirect: (to) => {
                const target = resolveMailboxRedirect(to.fullPath)
                if (!target) {
                    return { name: 'not-found' }
                }
                return target
            },
        },
        {
            path: '/sendmail',
            alias: '/:lang/sendmail',
            component: () => import('../views/index/SendWorkbench.vue')
        },
        {
            path: '/sendbox',
            alias: '/:lang/sendbox',
            redirect: (to) => {
                const langSeg = typeof to.params.lang === 'string' ? to.params.lang : ''
                const prefix = langSeg ? `/${langSeg}` : ''
                return {
                    path: `${prefix}/sendmail`,
                    query: { ...to.query, tab: 'self' },
                }
            }
        },
        {
            path: '/webhook',
            alias: '/:lang/webhook',
            component: () => import('../views/index/Webhook.vue')
        },
        {
            path: '/user',
            alias: '/:lang/user',
            component: User
        },
        {
            // meta.requiresSession = 该页面的唯一鉴权主体是用户会话（x-user-token），
            // 无会话时必须拦回登录页，否则匿名访客会看到未受保护的渲染结果
            //（历史上 /user/* 就是因为漏了它才出现"空表格"误判）。
            //
            // 判据不是"需要登录"，而是"只调 /user_api/*"：该前缀在
            // worker.ts 的鉴权中间件里只认 x-user-token，地址会话(jwt)、
            // 管理密码(adminAuth)、API-Key(unifiedApiKey) 通不过。
            // 因此以下路由**故意不声明**它——它们的鉴权主体另有其人：
            //   /sendmail、/webhook  → /api/*，走地址 bearer（AppSidebar 也按
            //                             hasAddressSession 决定是否展示入口）
            //   /telegram_mail       → /telegram/get_mail，走 Telegram initData，
            //                             深链用户不可能持有 userJwt
            // 接线见 beforeEach 末尾的 resolveSessionRedirect。
            path: '/user/addresses',
            alias: '/:lang/user/addresses',
            meta: { requiresSession: true },
            component: () => import('../views/user/AddressManagement.vue')
        },
        {
            path: '/user/external-accounts',
            alias: '/:lang/user/external-accounts',
            meta: { requiresSession: true },
            component: () => import('../views/user/UserMailAccounts.vue')
        },
        {
            path: '/user/settings',
            alias: '/:lang/user/settings',
            meta: { requiresSession: true },
            component: () => import('../views/user/UserSettings.vue')
        },
        {
            path: '/user/appearance',
            alias: '/:lang/user/appearance',
            component: () => import('../views/common/Appearance.vue')
        },
        {
            path: '/user/oauth2/callback',
            alias: '/:lang/user/oauth2/callback',
            component: UserOauth2Callback
        },
        // 管理员子功能直达路由
        {
            path: '/admin',
            alias: '/:lang/admin',
            component: () => import('../views/Admin.vue')
        },
        {
            path: '/admin/accounts',
            alias: '/:lang/admin/accounts',
            component: () => import('../views/Admin.vue')
        },
        {
            path: '/admin/users',
            alias: '/:lang/admin/users',
            component: () => import('../views/Admin.vue')
        },
        {
            path: '/admin/statistics',
            alias: '/:lang/admin/statistics',
            component: () => import('../views/Admin.vue')
        },
        {
            path: '/admin/ai-extract',
            alias: '/:lang/admin/ai-extract',
            component: () => import('../views/Admin.vue')
        },
        {
            path: '/admin/webhook',
            alias: '/:lang/admin/webhook',
            component: () => import('../views/Admin.vue')
        },
        {
            path: '/admin/database',
            alias: '/:lang/admin/database',
            component: () => import('../views/Admin.vue')
        },
	        {
	            path: '/admin/settings',
	            alias: '/:lang/admin/settings',
	            component: () => import('../views/Admin.vue')
	        },
	        {
	            path: '/admin/sender-access',
	            alias: '/:lang/admin/sender-access',
	            component: () => import('../views/Admin.vue')
	        },
        {
            path: '/admin/sendmail',
            alias: '/:lang/admin/sendmail',
            component: () => import('../views/Admin.vue')
        },
        {
            path: '/admin/sendbox',
            alias: '/:lang/admin/sendbox',
            component: () => import('../views/Admin.vue')
        },
        {
            path: '/admin/send-unknown',
            alias: '/:lang/admin/send-unknown',
            component: () => import('../views/Admin.vue')
        },
        {
            path: '/telegram_mail',
            alias: '/:lang/telegram_mail',
            component: () => import('../views/telegram/Mail.vue')
        },
        {
            path: '/domain-mailbox',
            alias: '/:lang/domain-mailbox',
            component: () => import('../views/DomainMailbox.vue')
        },
        {
            path: '/unified',
            alias: [
                `/:lang(${LOCALE_PATH_PATTERN})/unified`,
                '/unified/',
                `/:lang(${LOCALE_PATH_PATTERN})/unified/`,
            ],
            component: () => import('../views/UnifiedInbox.vue')
        },
        {
            path: '/unified/:id',
            alias: '/:lang/unified/:id',
            component: () => import('../views/UnifiedInboxDetail.vue')
        },
        {
            name: 'not-found',
            path: '/:pathMatch(.*)*',
            redirect: '/'
        }
    ]
});

router.beforeEach((to, from, next) => {
    const routeLocale = resolveSupportedLocale(to.path.split('/')[1])
    const resolvedLocale = routeLocale || DEFAULT_LOCALE
    i18n.global.locale.value = resolvedLocale

    if (routeLocale) {
        preferredLocale.value = routeLocale
    } else if (!preferredLocale.value) {
        preferredLocale.value = getPreferredLocale('', getBrowserLocales())
    }

    if (Object.prototype.hasOwnProperty.call(to.query, 'jwt')) {
        const jwtQuery = Array.isArray(to.query.jwt) ? to.query.jwt[0] : to.query.jwt
        if (typeof jwtQuery === 'string') {
            jwt.value = jwtQuery
        }
        const query = { ...to.query }
        delete query.jwt
        const isRoot = to.path === '/' || to.path === `/${routeLocale}` || to.path === `/${routeLocale}/`
        const targetPath = isRoot
            ? (routeLocale ? `/${routeLocale}/temp-mail` : '/temp-mail')
            : to.path
        next({
            path: targetPath,
            query,
            hash: to.hash,
            replace: true,
        })
        return
    }

    if (routeLocale) {
        const canonicalRoutePath = replaceLocaleInFullPath(to.fullPath, routeLocale)
        if (canonicalRoutePath !== to.fullPath) {
            return next(canonicalRoutePath)
        }
    }

    if (routeLocale === DEFAULT_LOCALE) {
        return next(replaceLocaleInFullPath(to.fullPath, DEFAULT_LOCALE))
    }

    // 登录态守卫必须放在最后：上面各段会因locale 规范化多次 next(...) 提前
    // return 并重新触发导航，放前面会在规范化过程中产生一次多余跳转。
    // 放在这里意味着守卫只对"已规范化的最终路径"生效一次。
    // 只有显式声明 meta.requiresSession 的路由会被拦；未声明的一律放行，
    // 因为它们各自已有正确的鉴权落点（就地鉴权 UI，或非用户会话的鉴权主体）——
    // 详见 /user/addresses 上方的约定注释。
    const sessionGuard = resolveSessionRedirect({
        fullPath: to.fullPath,
        locale: resolvedLocale,
        requiresSession: to.meta.requiresSession === true,
        hasUserSession: hasUserSession.value,
    })
    if (sessionGuard.kind === 'redirect') {
        return next(sessionGuard.to)
    }

    next()
})

export default router
