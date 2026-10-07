import { describe, expect, it } from 'vitest'
import { resolveStaleChannel, type ChannelAttribution } from '../session_channel'

const attr = (over: Partial<ChannelAttribution> = {}): ChannelAttribution => ({
    url: '/user_api/mail_accounts',
    sentUser: 'token-a',
    currentUser: 'token-a',
    ...over,
})

describe('resolveStaleChannel', () => {
    it('blames the user token when /user_api rejects it', () => {
        expect(resolveStaleChannel(attr())).toBe('user')
    })

    it('never blames the admin password for a /user_api rejection', () => {
        // siteClient 同时发多个通道，但 /user_api/* 中间件只认 x-user-token。
        expect(resolveStaleChannel(attr({ sentAdmin: 'admin-a', currentAdmin: 'admin-a' }))).toBe('user')
        expect(resolveStaleChannel(attr({ sentAdmin: 'admin-old', currentAdmin: 'admin-new' }))).toBe('user')
    })

    it('leaves the current token alone when a newer one arrived mid-flight', () => {
        // 期间已续期（getUserSettings 自动换 token）或重新登录，这条 401 属于旧作用域。
        expect(resolveStaleChannel(attr({ sentUser: 'token-a', currentUser: 'token-b' }))).toBe('none')
    })

    it('has nothing to clear when the request carried no user token', () => {
        expect(resolveStaleChannel(attr({ sentUser: undefined, currentUser: undefined }))).toBe('none')
        expect(resolveStaleChannel(attr({ sentUser: undefined, currentUser: 'token-a' }))).toBe('none')
    })

    it('blames the admin password when /admin rejects the one still in use', () => {
        const base = { url: '/admin/accounts', sentUser: undefined, currentUser: undefined }
        // 用户输错密码后 adminAuth 保持不变就发出了请求，后端拒绝的正是当前这个值。
        expect(resolveStaleChannel({ ...base, sentAdmin: 'wrong', currentAdmin: 'wrong' })).toBe('admin')
    })

    it('leaves a freshly retyped admin password alone when an older request fails late', () => {
        // 回归：曾把判据写成"与当前值不同才归责"，于是恰好在这里清空了用户刚输的
        // 新密码，而真正失效（值未变化）的那一支反而不清理，自愈完全失效。
        const base = { url: '/admin/accounts', sentUser: undefined, currentUser: undefined }
        expect(resolveStaleChannel({ ...base, sentAdmin: 'wrong', currentAdmin: 'correct-new' })).toBe('none')
    })

    it('has nothing to clear when the /admin request carried no password', () => {
        const base = { url: '/admin/accounts', sentUser: undefined, currentUser: undefined }
        expect(resolveStaleChannel({ ...base, sentAdmin: undefined, currentAdmin: 'admin-a' })).toBe('none')
    })

    it('applies the same "still current" rule to both channel families', () => {
        // /user_api 与 /admin 的判据必须同构，否则其中一支的自愈是反的。
        const cases: Array<[ChannelAttribution, 'user' | 'admin' | 'none']> = [
            [{ url: '/user_api/settings', sentUser: 'a', currentUser: 'a', sentAdmin: 'p', currentAdmin: 'p' }, 'user'],
            [{ url: '/user_api/settings', sentUser: 'a', currentUser: 'b', sentAdmin: 'p', currentAdmin: 'p' }, 'none'],
            [{ url: '/admin/users', sentAdmin: 'p', currentAdmin: 'p', sentUser: 'a', currentUser: 'a' }, 'admin'],
            [{ url: '/admin/users', sentAdmin: 'p', currentAdmin: 'q', sentUser: 'a', currentUser: 'a' }, 'none'],
        ]
        for (const [input, expected] of cases) {
            expect(resolveStaleChannel(input), `${input.url} sent=${input.sentUser ?? input.sentAdmin}`).toBe(expected)
        }
    })

    it('leaves endpoints outside both channel families to their existing modal strategy', () => {
        for (const url of ['/api/settings', '/open_api/site_info', '/telegram/send']) {
            expect(resolveStaleChannel({ url, sentUser: 'token-a', currentUser: 'token-a', sentAdmin: 'admin-a', currentAdmin: 'admin-a' }), url).toBe('none')
        }
    })

    it('treats every /admin/* path as the admin family, including admin-namespaced unified routes', () => {
        // /admin/unified/* 由 x-admin-auth 保护（worker/src/user_api/mail_accounts.ts），
        // 属于 /admin 家族而非"其他端点"：当前在用的管理密码被拒就该清理。
        expect(resolveStaleChannel({ url: '/admin/unified/mail_accounts', sentAdmin: 'a', currentAdmin: 'a' })).toBe('admin')
    })
})
