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
  ctx.state = Object.fromEntries(['loading', 'auth', 'jwt', 'showAuth', 'adminAuth', 'showAdminAuth', 'userJwt', 'unifiedApiKey'].map(key => [key, ref('')]))
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
