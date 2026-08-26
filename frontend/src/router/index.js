import { createRouter, createWebHistory } from 'vue-router'
import Index from '../views/Index.vue'
import User from '../views/User.vue'
import UserOauth2Callback from '../views/user/UserOauth2Callback.vue'
import i18n from '../i18n'
import { useGlobalState } from '../store'
import {
    DEFAULT_LOCALE,
    getBrowserLocales,
    getPreferredLocale,
    replaceLocaleInFullPath,
    resolveSupportedLocale,
} from '../i18n/utils'

const { jwt, preferredLocale } = useGlobalState()

const router = createRouter({
    history: createWebHistory(),
    routes: [
        {
            path: '/',
            alias: '/:lang/',
            component: Index
        },
        {
            path: '/mailbox',
            alias: '/:lang/mailbox',
            component: Index
        },
        {
            path: '/sendmail',
            alias: '/:lang/sendmail',
            component: () => import('../views/index/SendMail.vue')
        },
        {
            path: '/sendbox',
            alias: '/:lang/sendbox',
            component: () => import('../views/index/SendBoxPage.vue')
        },
        {
            path: '/user',
            alias: '/:lang/user',
            component: User
        },
        {
            path: '/user/addresses',
            alias: '/:lang/user/addresses',
            component: () => import('../views/user/AddressManagement.vue')
        },
        {
            path: '/user/external-accounts',
            alias: '/:lang/user/external-accounts',
            component: () => import('../views/user/UserMailAccounts.vue')
        },
        {
            path: '/user/settings',
            alias: '/:lang/user/settings',
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
            path: '/telegram_mail',
            alias: '/:lang/telegram_mail',
            component: () => import('../views/telegram/Mail.vue')
        },
        {
            path: '/unified',
            alias: '/:lang/unified',
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
        next({
            path: to.path,
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

    next()
})

export default router
