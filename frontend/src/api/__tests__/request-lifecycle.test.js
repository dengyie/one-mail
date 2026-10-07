// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

const ctx = vi.hoisted(() => ({ request: vi.fn(), state: null, push: vi.fn() }))
vi.mock('axios', () => ({ default: { create: () => ({ request: ctx.request }) } }))
vi.mock('../../store', () => ({ useGlobalState: () => ctx.state }))
vi.mock('../../router', () => ({ default: { push: ctx.push } }))
vi.mock('../../utils/fingerprint', () => ({ getFingerprint: async () => 'test' }))
let api
beforeEach(async () => {
  vi.resetModules()
  ctx.state = Object.fromEntries(['loading', 'auth', 'jwt', 'showAuth', 'adminAuth', 'userJwt', 'unifiedApiKey'].map(key => [key, ref('')]))
  Object.assign(ctx.state, { settings: ref({}), openSettings: ref({}), userOpenSettings: ref({}), userSettings: ref({}), announcement: ref('') })
  ctx.request.mockReset(); ctx.push.mockReset()
  api = (await import('../index')).api
})

describe('request ownership at the HTTP boundary', () => {
  it('passes the view AbortSignal to axios', async () => {
    ctx.state.userJwt.value = 'user-a'
    ctx.request.mockResolvedValue({ status: 200, data: { results: [] } })
    const controller = new AbortController()
    await api.unified.listEmails({ limit: 1, with_count: 0 }, { signal: controller.signal })
    expect(ctx.request.mock.calls[0][1].signal).toBe(controller.signal)
  })
  it.each(['user', 'admin', 'key'])('a stale %s 401 cannot erase newer credentials', async channel => {
    const credential = { user: 'userJwt', admin: 'adminAuth', key: 'unifiedApiKey' }[channel]
    ctx.state[credential].value = 'old-session'
    let resolve
    ctx.request.mockImplementation((url, config) => new Promise(done => { resolve = () => done({ status: 401, data: { error: 'expired' }, config: { ...config, url } }) }))
    const pending = api.unified.getEmail('mail-a')
    ctx.state[credential].value = 'new-session'
    resolve()
    await expect(pending).rejects.toThrow('401')
    expect(ctx.state[credential].value).toBe('new-session')
    expect(ctx.push).not.toHaveBeenCalled()
  })
  it('strips only a failed attached admin credential from the current user', async () => {
    ctx.state.userJwt.value = 'user-a'; ctx.state.adminAuth.value = 'admin-a'
    ctx.request.mockImplementation(async (url, config) => ({ status: 401, data: {}, config: { ...config, url } }))
    await expect(api.unified.getEmail('mail-a')).rejects.toThrow('401')
    expect(ctx.state.userJwt.value).toBe('user-a')
    expect(ctx.state.adminAuth.value).toBe('')
    expect(ctx.push).not.toHaveBeenCalled()
  })
  it('uses explicit key-creation credentials without mutating the session', async () => {
    ctx.state.adminAuth.value = 'session-admin'
    ctx.request.mockResolvedValue({ status: 200, data: { key: 'generated-key' } })
    await api.admin.createUnifiedKey({ name: 'readonly', role: 'readonly' }, 'one-request-admin')
    expect(ctx.request.mock.calls[0][1].headers['x-admin-auth']).toBe('one-request-admin')
    expect(ctx.state.adminAuth.value).toBe('session-admin')
  })
})

// siteClient 的 401 自愈此前完全没有测试，而它是本次改动里风险最高的一处：
// 它按端点家族决定清哪个凭据，清错就是误删用户的有效会话。
describe('siteClient self-heals the credential its endpoint family owns', () => {
  const reply401 = (url, config) => ({ status: 401, data: { error: 'expired' }, config: { ...config, url } })
  const silent = { error: vi.fn() }
  let resolve401

  beforeEach(() => { ctx.request.mockImplementation(reply401) })

  it('drops an expired user token and sends the visitor to sign in', async () => {
    ctx.state.userJwt.value = 'stale-user'
    await api.getUserSettings(silent)
    expect(ctx.state.userJwt.value).toBe('')
    // 跳登录走的是动态 import()（绕开 router→views→api 的静态环），晚于请求 settle。
    await vi.waitFor(() => expect(ctx.push).toHaveBeenCalledWith('/user'))
  })

  it('leaves a renewed token alone when the old request fails late', async () => {
    // getUserSettings 的自动换 token 会改写 userJwt；迟到的旧 401 不能删掉它。
    ctx.state.userJwt.value = 'old-user'
    ctx.request.mockImplementation((url, config) => new Promise(done => { resolve401 = () => done(reply401(url, config)) }))
    const pending = api.getUserSettings(silent)
    // apiFetch 会先 await 指纹再发请求，等真正 in-flight 再换 token，才算"迟到"。
    await vi.waitFor(() => expect(ctx.request).toHaveBeenCalled())
    ctx.state.userJwt.value = 'renewed-user'
    resolve401()
    await pending
    expect(ctx.state.userJwt.value).toBe('renewed-user')
    expect(ctx.push).not.toHaveBeenCalled()
  })

  it('keeps an admin-elevated session in place instead of bouncing to sign-in', async () => {
    // 复合提权：管理密码仍在，就不该把用户踢出正常会话。
    ctx.state.userJwt.value = 'stale-user'
    ctx.state.adminAuth.value = 'session-admin'
    await api.getUserSettings(silent)
    expect(ctx.state.userJwt.value).toBe('')
    expect(ctx.state.adminAuth.value).toBe('session-admin')
    expect(ctx.push).not.toHaveBeenCalled()
  })

  it('clears only a rejected admin password and never the user session', async () => {
    ctx.state.userJwt.value = 'healthy-user'
    ctx.state.adminAuth.value = 'wrong-admin'
    await expect(api.adminShowAddressCredential('1')).rejects.toThrow('401')
    expect(ctx.state.adminAuth.value).toBe('')
    expect(ctx.state.userJwt.value).toBe('healthy-user')
    expect(ctx.push).not.toHaveBeenCalled()
  })

  it('does not touch a freshly retyped admin password when an older request fails late', async () => {
    ctx.state.adminAuth.value = 'wrong-admin'
    ctx.request.mockImplementation((url, config) => new Promise(done => { resolve401 = () => done(reply401(url, config)) }))
    const pending = api.adminShowAddressCredential('1')
    await vi.waitFor(() => expect(ctx.request).toHaveBeenCalled())
    ctx.state.adminAuth.value = 'correct-admin'
    resolve401()
    await expect(pending).rejects.toThrow('401')
    expect(ctx.state.adminAuth.value).toBe('correct-admin')
  })

  it('ignores an anonymous 401 on /user_api rather than clearing what was never sent', async () => {
    // 未登录探针请求本就没有会话，谈不上过期。
    await api.getUserSettings(silent)
    expect(ctx.state.userJwt.value).toBe('')
    expect(ctx.push).not.toHaveBeenCalled()
  })
})
