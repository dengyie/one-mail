/**
 * 401 凭据归属判定（纯函数）。
 *
 * siteClient 会同时发送 x-user-token / x-admin-auth / Authorization 等多个通道，
 * 无法像 unifiedClient 那样靠"用了哪条通道"归属，只能按端点家族判定：
 * 后端 worker.ts 的 /user_api/* 中间件只认 x-user-token，/admin/* 只认
 * x-admin-auth，401 必然意味着该通道的凭据有问题。
 *
 * 再叠加"延迟响应归属原凭据作用域"：只有当请求发出时的凭据与当前值**仍然相同**时，
 * 才能判定当前值已失效并清空。若两者不同，说明期间已经续期或重新登录，这条 401
 * 属于旧作用域——此时清空会把用户刚换上的新凭据误删，必须放弃。
 *
 * 注意两个分支的判据同构（都是"相同才归责"）。写成"不同才归责"会让自愈恰好失效：
 * 密码真的失效时凭据并不会变化，变化恰恰说明它已经不是当前那个了。
 */

export type StaleChannel = 'user' | 'admin' | 'none'

export interface ChannelAttribution {
    /** 请求路径，如 '/user_api/mail_accounts'。 */
    url: string
    /** 请求发出时携带的 x-user-token 快照。 */
    sentUser?: string
    /** 当前 store 里的 userJwt。 */
    currentUser?: string
    /** 请求发出时携带的 x-admin-auth 快照。 */
    sentAdmin?: string
    /** 当前 store 里的 adminAuth。 */
    currentAdmin?: string
}

export const resolveStaleChannel = (input: ChannelAttribution): StaleChannel => {
    if (input.url.startsWith('/admin')) {
        // 本来就没带管理密码，谈不上"过期"。
        if (!input.sentAdmin) return 'none'
        // 管理密码失效只清管理密码，用户会话不受影响。
        // 期间已换成新密码 → 这条 401 属于旧作用域，不动当前值。
        return input.sentAdmin === input.currentAdmin ? 'admin' : 'none'
    }
    if (input.url.startsWith('/user_api')) {
        // 本来就没带用户会话，谈不上"过期"（例如匿名探测请求）。
        if (!input.sentUser) return 'none'
        // 期间已换成新凭据 → 这条 401 属于旧作用域，不动当前值。
        return input.sentUser === input.currentUser ? 'user' : 'none'
    }
    // /api、/open_api、/telegram 等由各自的弹窗策略处理。
    return 'none'
}
