// @vitest-environment jsdom
import { createApp, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DatabaseManager from '../DatabaseManager.vue'

const { fetchApi, message } = vi.hoisted(() => ({
  fetchApi: vi.fn(),
  message: { success: vi.fn(), error: vi.fn() },
}))
vi.mock('@/api', () => ({ api: { fetch: fetchApi } }))
vi.mock('@/i18n/app', () => ({ useScopedI18n: () => ({ t: key => key }) }))
vi.mock('naive-ui', async importOriginal => ({ ...await importOriginal(), useMessage: () => message }))

const mounted = []
const current = { need_initialization: false, need_migration: false, current_db_version: 'v0.0.12', code_db_version: 'v0.0.12' }
const initial = { ...current, need_initialization: true, current_db_version: null }
const outdated = { ...current, need_migration: true, current_db_version: null }
const modes = [
  { label: 'init', endpoint: '/admin/db_initialize', status: initial, success: 'initializationSuccess' },
  { label: 'migration', endpoint: '/admin/db_migration', status: outdated, success: 'migrationSuccess' },
]
const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); await nextTick() }
const button = (host, label) => [...host.querySelectorAll('button')].find(el => el.textContent.trim() === label)
async function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(DatabaseManager)
  app.mount(host)
  const unmount = () => { app.unmount(); host.remove() }
  mounted.push(unmount)
  await flush()
  return { host, unmount }
}

beforeEach(() => { vi.clearAllMocks(); fetchApi.mockReset() })
afterEach(() => { for (const unmount of mounted.splice(0)) unmount() })

describe.each(modes)('database $label', mode => {
  it('submits once while the operation is pending, including clicks before render', async () => {
    const pending = deferred()
    fetchApi.mockResolvedValueOnce(mode.status).mockReturnValue(pending.promise)
    const { host } = await mount()
    const action = button(host, mode.label)
    action.click()
    action.click()
    await flush()
    expect(fetchApi.mock.calls.filter(([path]) => path === mode.endpoint)).toHaveLength(1)
    expect(action.disabled).toBe(true)
  })

  it('confirms success only after reading the resulting version', async () => {
    fetchApi.mockResolvedValueOnce(mode.status).mockResolvedValueOnce({ success: true }).mockResolvedValueOnce(current)
    const { host } = await mount()
    button(host, mode.label).click()
    await flush()
    expect(fetchApi.mock.calls.map(([path]) => path)).toEqual(['/admin/db_version', mode.endpoint, '/admin/db_version'])
    expect(message.success).toHaveBeenCalledExactlyOnceWith(mode.success)
    expect(host.textContent).toContain('v0.0.12')
    expect(button(host, mode.label)).toBeUndefined()
  })

  it('does not report success or repeat DDL when the subsequent status read fails', async () => {
    fetchApi.mockResolvedValueOnce(mode.status).mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error('status unavailable')).mockResolvedValueOnce(current)
    const { host } = await mount()
    button(host, mode.label).click()
    await flush()
    expect(message.success).not.toHaveBeenCalled()
    expect(host.textContent).toContain('status unavailable')
    expect(button(host, mode.label)).toBeUndefined()
    button(host, 'retry').click()
    await flush()
    expect(fetchApi.mock.calls.map(([path]) => path)).toEqual(['/admin/db_version', mode.endpoint, '/admin/db_version', '/admin/db_version'])
    expect(host.textContent).toContain('v0.0.12')
  })

  it('does not confirm an operation if the database still requires migration', async () => {
    fetchApi.mockResolvedValueOnce(mode.status).mockResolvedValueOnce({ success: true }).mockResolvedValueOnce(outdated)
    const { host } = await mount()
    button(host, mode.label).click()
    await flush()
    expect(message.success).not.toHaveBeenCalled()
    expect(host.textContent).toContain('statusNotCurrent')
    expect(button(host, 'retry')).toBeDefined()
  })
})

it('offers a status retry after an initial read failure without suggesting DDL', async () => {
  fetchApi.mockRejectedValueOnce(new Error('D1 unavailable')).mockResolvedValueOnce(outdated)
  const { host } = await mount()
  expect(host.textContent).toContain('D1 unavailable')
  expect(button(host, 'init')).toBeUndefined()
  expect(button(host, 'migration')).toBeUndefined()
  button(host, 'retry').click()
  await flush()
  expect(button(host, 'migration')).toBeDefined()
  expect(fetchApi.mock.calls.every(([path]) => path === '/admin/db_version')).toBe(true)
})

it('surfaces a failed migration without issuing a status read or success message', async () => {
  fetchApi.mockResolvedValueOnce(outdated).mockRejectedValueOnce(new Error('migration rejected'))
  const { host } = await mount()
  button(host, 'migration').click()
  await flush()
  expect(host.textContent).toContain('migration rejected')
  expect(message.success).not.toHaveBeenCalled()
  expect(fetchApi).toHaveBeenCalledTimes(2)
})

it('rejects a malformed status response rather than showing it as healthy', async () => {
  fetchApi.mockResolvedValueOnce({ need_initialization: false, need_migration: null })
  const { host } = await mount()
  expect(host.textContent).toContain('invalidStatus')
  expect(button(host, 'retry')).toBeDefined()
})

it('aborts a pending status read when the view is removed', async () => {
  const pending = deferred()
  fetchApi.mockReturnValue(pending.promise)
  const { unmount } = await mount()
  const options = fetchApi.mock.calls[0][1]
  unmount()
  mounted.pop()
  expect(options.signal.aborted).toBe(true)
  pending.reject(new Error('cancelled'))
  await flush()
  expect(message.error).not.toHaveBeenCalled()
})

it('does not refresh or announce a completed migration after the view is removed', async () => {
  const pending = deferred()
  fetchApi.mockResolvedValueOnce(outdated).mockReturnValue(pending.promise)
  const { host, unmount } = await mount()
  button(host, 'migration').click()
  await flush()
  unmount()
  mounted.pop()
  pending.resolve({ success: true })
  await flush()
  expect(fetchApi).toHaveBeenCalledTimes(2)
  expect(message.success).not.toHaveBeenCalled()
})
