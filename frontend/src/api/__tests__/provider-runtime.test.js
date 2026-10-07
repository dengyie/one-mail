// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
const ctx = vi.hoisted(() => ({ request: vi.fn(), state: null }))
vi.mock('axios', () => ({ default: { create: () => ({ request: ctx.request }) } }))
vi.mock('../../store', () => ({ useGlobalState: () => ctx.state }))
vi.mock('../../router', () => ({ default: { push: vi.fn() } }))
vi.mock('../../utils/fingerprint', () => ({ getFingerprint: async () => 'test' }))
let api
const response = data => ({ status: 200, data })
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
beforeEach(async () => {
  vi.resetModules()
  ctx.state = Object.fromEntries(['loading', 'auth', 'jwt', 'showAuth', 'adminAuth', 'userJwt', 'unifiedApiKey'].map(key => [key, ref('')]))
  Object.assign(ctx.state, { settings: ref({}), openSettings: ref({}), userOpenSettings: ref({}), userSettings: ref({}), announcement: ref('') })
  ctx.state.userJwt.value = 'user-a'
  ctx.request.mockReset()
  api = (await import('../index')).api
})
afterEach(() => vi.useRealTimers())

describe('production unified mutation API', () => {
  it.each(['succeeded', 'failed', 'unsupported'])('waits for unread terminal %s', async status => {
    let complete
    ctx.request.mockResolvedValueOnce(response({ status: 'queued', job_id: 'j-unread', desired_value: 0 }))
      .mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    let settled = false
    const pending = api.unified.markUnread('mail/1')
    const observed = pending.then(value => ({ value }), error => ({ error })).finally(() => { settled = true })
    await flush()
    expect(ctx.request).toHaveBeenCalledTimes(2)
    expect(settled).toBe(false)
    complete(response({ status, desired_value: 0, error: status === 'succeeded' ? null : 'provider refused' }))
    const result = await observed
    if (status === 'succeeded') expect(result.value).toMatchObject({ status, is_read: 0 })
    else expect(result.error.message).toContain('provider refused')
  })
  it.each(['admin', 'elevated', 'key'])('uses the same %s credentials for write and polling', async channel => {
    ctx.state.userJwt.value = channel === 'elevated' ? 'user-a' : ''
    ctx.state.adminAuth.value = channel === 'key' ? '' : 'admin-a'
    ctx.state.unifiedApiKey.value = 'key-a'
    ctx.request.mockResolvedValueOnce(response({ status: 'queued', job_id: 'j-star' }))
      .mockResolvedValueOnce(response({ status: 'succeeded', desired_value: 1 }))
    await expect(api.unified.toggleStar('mail-a', 1)).resolves.toMatchObject({ is_starred: 1 })
    const headers = ctx.request.mock.calls.map(([, options]) => options.headers)
    expect(headers).toHaveLength(2)
    expect(headers[1]).toEqual(headers[0])
    if (channel === 'key') expect(headers[1].Authorization).toBe('Bearer key-a')
    else { expect(headers[1]['x-admin-auth']).toBe('admin-a'); expect(headers[1].Authorization).toBeUndefined() }
  })
  it('uses administrator authentication for folders, move and delete', async () => {
    ctx.state.userJwt.value = ''; ctx.state.adminAuth.value = 'admin-a'
    ctx.request.mockResolvedValue(response({ status: 'succeeded', results: [], target_folder: 'Archive', deleted: true }))
    await api.unified.listFolders({ account_id: 'account-a' })
    await api.unified.moveEmail('mail-a', 5)
    await api.unified.deleteEmail('mail-a')
    expect(ctx.request).toHaveBeenCalledTimes(3)
    for (const [, options] of ctx.request.mock.calls) expect(options.headers['x-admin-auth']).toBe('admin-a')
  })
  it('cancels a pending status request when the view aborts', async () => {
    ctx.request.mockResolvedValueOnce(response({ status: 'queued', job_id: 'j-read' }))
      .mockImplementationOnce(() => new Promise(() => {}))
    const controller = new AbortController()
    const pending = api.unified.markRead('mail-a', { signal: controller.signal })
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await flush(); controller.abort(); await rejected
    expect(ctx.request.mock.calls[1][1].signal.aborted).toBe(true)
  })
  it('rejects a terminal result after attached administrator credentials change', async () => {
    ctx.state.adminAuth.value = 'admin-a'
    let complete
    ctx.request.mockResolvedValueOnce(response({ status: 'queued', job_id: 'j-read' }))
      .mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    const pending = api.unified.markRead('mail-a')
    const rejected = expect(pending).rejects.toMatchObject({ code: 'mutation_auth_changed' })
    await flush(); ctx.state.adminAuth.value = ''; complete(response({ status: 'succeeded', desired_value: 1 })); await rejected
  })
})
