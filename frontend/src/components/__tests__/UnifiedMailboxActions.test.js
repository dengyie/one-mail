// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, nextTick, reactive, ref } from 'vue'
const ctx = vi.hoisted(() => ({ state: null, api: null, push: vi.fn(), success: vi.fn(), error: vi.fn() }))
vi.mock('../../store', () => ({ useGlobalState: () => ctx.state }))
vi.mock('../../api', () => ({ api: { unified: new Proxy({}, { get: (_, key) => ctx.api[key] }) } }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: ctx.push }) }))
vi.mock('naive-ui', async original => ({ ...await original(), useMessage: () => ({ success: ctx.success, error: ctx.error }) }))
import UnifiedMailboxActions from '../UnifiedMailboxActions.vue'
let app, host
const flush = async () => { for (let i = 0; i < 15; i++) { await Promise.resolve(); await nextTick() } }
beforeEach(() => {
  ctx.state = { userJwt: ref('user-a'), adminAuth: ref(''), unifiedApiKey: ref('') }
  ctx.api = { listFolders: vi.fn().mockResolvedValue({ results: [] }), deleteEmail: vi.fn() }
  ctx.push.mockReset(); ctx.success.mockReset(); ctx.error.mockReset()
})
afterEach(() => { app?.unmount(); host?.remove(); vi.restoreAllMocks() })
async function mount() {
  const email = reactive({ id: 'mail-a', source: 'imap_gmail', account_id: 'account-a', source_folder: 'INBOX' })
  host = document.createElement('div'); document.body.append(host)
  app = createApp(UnifiedMailboxActions, { email })
  app.mount(host); await flush()
}
it('cancels folder loading on unmount without reporting a late error', async () => {
  let reject
  ctx.api.listFolders.mockImplementation(() => new Promise((_, fail) => { reject = fail }))
  await mount()
  const options = ctx.api.listFolders.mock.calls[0][1]
  app.unmount(); app = null
  expect(options.signal.aborted).toBe(true)
  reject(new Error('late folder error')); await flush()
  expect(ctx.error).not.toHaveBeenCalled()
})
it.each(['unmount', 'credential'])('cancels deletion on %s and suppresses late navigation', async change => {
  let complete
  ctx.api.deleteEmail.mockImplementation(() => new Promise(resolve => { complete = resolve }))
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  await mount()
  const remove = [...host.querySelectorAll('button')].find(button => button.textContent.trim() === '删除')
  remove.click(); await flush()
  const options = ctx.api.deleteEmail.mock.calls[0][1]
  if (change === 'unmount') { app.unmount(); app = null }
  else { ctx.state.adminAuth.value = 'new-admin'; await flush() }
  expect(options.signal.aborted).toBe(true)
  complete({ deleted: true }); await flush()
  expect(ctx.push).not.toHaveBeenCalled()
  expect(ctx.success).not.toHaveBeenCalled()
})
