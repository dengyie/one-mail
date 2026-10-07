// @vitest-environment jsdom
import { createApp, nextTick, reactive, ref } from 'vue'
import { createI18n } from 'vue-i18n'
import { afterEach, beforeEach, vi } from 'vitest'
import { I18N_MESSAGES } from '../../i18n/messages'

const ctx = vi.hoisted(() => ({ state: null, route: null, api: null, messages: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('../../store', () => ({ useGlobalState: () => ctx.state, MIN_AUTO_REFRESH_INTERVAL: 30 }))
vi.mock('../../api', () => ({ api: new Proxy({}, { get: (_, key) => ctx.api[key] }) }))
vi.mock('vue-router', () => ({ useRoute: () => ctx.route, useRouter: () => ({
  push: vi.fn(), back: vi.fn(), replace: ({ query }) => { ctx.route.query = query; return Promise.resolve() },
}) }))
vi.mock('naive-ui', async original => ({ ...await original(), useMessage: () => ctx.messages }))
vi.mock('../../components/UnifiedMailboxActions.vue', () => ({ default: { render: () => null } }))

const email = (id = 'mail-a', subject = 'Private mail A') => ({ id, subject, from_addr: 'sender@example.com', to_addr: 'recipient@example.com', source: 'imap_gmail', account_id: 'account-a', received_at: 1791334800000, is_read: 0, is_starred: 0, text_body: '', html_body: '', attachments_json: '[]' })
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const mounts = []
const flush = async () => { for (let i = 0; i < 15; i++) { await Promise.resolve(); await nextTick() } }
async function mount(View) {
  const host = document.createElement('div'); document.body.append(host)
  const app = createApp(View)
  app.use(createI18n({ legacy: false, locale: 'en', messages: I18N_MESSAGES }))
  app.mount(host)
  const unmount = () => { app.unmount(); host.remove() }
  mounts.push(unmount)
  await flush()
  return { host, unmount }
}
const button = (host, text) => [...host.querySelectorAll('button')].find(node => node.textContent.trim() === text)

beforeEach(() => {
  ctx.state = { userJwt: ref('user-a'), adminAuth: ref(''), unifiedApiKey: ref(''), userSettings: ref({ user_id: 1 }), configAutoRefreshInterval: ref(30), autoLoadRemoteImages: ref(false) }
  ctx.route = reactive({ path: '/unified', fullPath: '/unified', query: {}, params: { id: 'mail-a' } })
  ctx.api = {
    getUserSettings: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn().mockResolvedValue({ results: [] }),
    userMailAccounts: { list: vi.fn().mockResolvedValue({ results: [] }) },
    unified: {
      listEmails: vi.fn().mockResolvedValue({ results: [email()], count: 1, next_cursor: null, has_more: false }),
      getEmail: vi.fn().mockResolvedValue(email()), meta: vi.fn().mockResolvedValue({ sources: [], accounts: [], to_addrs: [] }),
      verifcodes: vi.fn().mockResolvedValue({ results: [] }), stats: vi.fn().mockResolvedValue({ count: 1, unread: 1 }),
      markRead: vi.fn().mockResolvedValue({ ok: true }), markUnread: vi.fn().mockResolvedValue({ ok: true }), toggleStar: vi.fn().mockResolvedValue({ is_starred: 1 }),
    },
  }
  vi.clearAllMocks()
})
afterEach(() => { mounts.splice(0).forEach(unmount => unmount()); vi.useRealTimers() })


export { ctx, email, deferred, flush, mount, mounts, button }
