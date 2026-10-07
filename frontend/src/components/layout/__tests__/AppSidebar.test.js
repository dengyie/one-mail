// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, reactive, ref } from 'vue'
import { createI18n } from 'vue-i18n'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18N_MESSAGES } from '../../../i18n/messages'
import AppSidebar from '../AppSidebar.vue'

const context = vi.hoisted(() => ({ state: null, route: null, push: vi.fn(), clear: vi.fn() }))
vi.mock('../../../store', () => ({ useGlobalState: () => context.state }))
vi.mock('vue-router', () => ({ useRoute: () => context.route, useRouter: () => ({ push: context.push }) }))
vi.mock('../../../utils/address-cache', () => ({ clearLocalAddressCache: context.clear }))
vi.mock('naive-ui', async importOriginal => {
  const actual = await importOriginal()
  const { defineComponent, h } = await import('vue')
  return { ...actual,
    NModal: defineComponent({ props: ['show'], setup: (props, { slots }) => () => props.show ? h('section', [slots.default?.(), slots.action?.()]) : null }),
    NButton: defineComponent({ setup: (_, { slots, attrs }) => () => h('button', attrs, slots.default?.()) }),
  }
})
const mounted = []
beforeEach(() => {
  context.route = reactive({ path: '/unified', query: {} })
  context.state = Object.fromEntries(['userJwt', 'jwt', 'auth', 'adminAuth', 'addressPassword', 'userOauth2SessionState', 'userOauth2SessionClientID', 'unifiedApiKey'].map(key => [key, ref('')]))
  Object.assign(context.state, { settings: ref({ address: '' }), userSettings: ref({ user_email: '', is_admin: false }), openSettings: ref({ enableSendMail: true, enableWebhook: true }), showAdminPage: ref(false) })
  context.push.mockReset().mockResolvedValue(undefined)
  context.clear.mockReset()
})
afterEach(() => { for (const { app, host } of mounted.splice(0)) { app.unmount(); host.remove() } })
async function render(props = {}) {
  const host = document.createElement('div'); document.body.appendChild(host)
  const app = createApp(AppSidebar, props)
  app.use(createI18n({ legacy: false, locale: 'en', messages: I18N_MESSAGES }))
  app.component('RouterLink', defineComponent({ props: ['to'], setup: (props, { slots, attrs }) => () => h('a', { ...attrs, href: props.to }, slots.default?.()) }))
  app.mount(host); mounted.push({ app, host }); await nextTick(); return host
}
const hrefs = host => [...host.querySelectorAll('nav a')].map(a => a.getAttribute('href'))

describe('AppSidebar navigation and session boundaries', () => {
  it('gives signed-out visitors useful inbox and temporary-mail entry points', async () => {
    const host = await render()
    expect(hrefs(host)).toContain('/en/unified')
    expect(hrefs(host)).toContain('/en/temp-mail')
    expect(hrefs(host)).not.toContain('/en/domain-mailbox')
    expect(hrefs(host)).not.toContain('/en/user/external-accounts')
    expect(host.querySelector('.mail-compose').getAttribute('href')).toBe('/en/user')
  })
  it('hides temporary mail for account sessions, while keeping account and sending tools', async () => {
    context.state.userJwt.value = 'user-session'
    const host = await render()
    expect(hrefs(host)).not.toContain('/en/temp-mail')
    expect(hrefs(host)).toContain('/en/user/external-accounts')
    expect(host.querySelectorAll('a[href^="/en/sendmail"]')).toHaveLength(1)
    expect(host.querySelector('.mail-compose').getAttribute('href')).toBe('/en/sendmail')
  })
  it('keeps temporary-mail and webhook entry points for address-only sessions', async () => {
    context.state.jwt.value = 'address-session'
    const host = await render()
    expect(hrefs(host)).toContain('/en/temp-mail')
    expect(hrefs(host)).toContain('/en/webhook')
    expect(hrefs(host)).not.toContain('/en/user/external-accounts')
  })
  it('does not grant domain-mail access from the disabled-password-check flag', async () => {
    context.state.openSettings.value.disableAdminPasswordCheck = true
    context.state.showAdminPage.value = true
    const host = await render()
    expect(hrefs(host)).not.toContain('/en/domain-mailbox')
  })
  it.each(['role', 'password', 'api-key'])('exposes domain mail for %s credentials', async kind => {
    if (kind === 'role') { context.state.userJwt.value = 'user'; context.state.userSettings.value.is_admin = true }
    if (kind === 'password') context.state.adminAuth.value = 'admin-password'
    if (kind === 'api-key') context.state.unifiedApiKey.value = 'standalone-api-key'
    const host = await render()
    expect(hrefs(host)).toContain('/en/domain-mailbox')
  })
  it('does not let an API key upgrade a signed-in ordinary account', async () => {
    context.state.userJwt.value = 'ordinary-account'
    context.state.unifiedApiKey.value = 'api-key'
    expect(hrefs(await render())).not.toContain('/en/domain-mailbox')
  })
  it('keeps admin sending, unknown deliveries and sender management reachable without an address session', async () => {
    context.state.adminAuth.value = 'admin-password'; context.state.showAdminPage.value = true
    const host = await render()
    for (const path of ['/admin/send-unknown', '/admin/sendmail', '/admin/sender-access', '/admin/sendbox']) expect(hrefs(host)).toContain('/en' + path)
    expect(host.querySelectorAll('a[href^="/en/sendmail"]')).toHaveLength(1)
    expect(host.querySelector('.mail-compose').getAttribute('href')).toBe('/en/sendmail')
  })
  it('marks only the selected locale-aware inbox filter as current', async () => {
    context.route.path = '/en/unified'; context.route.query.view = 'starred'
    const host = await render({ collapsed: true })
    const active = host.querySelectorAll('nav [aria-current="page"]')
    expect(active).toHaveLength(1)
    expect(active[0].getAttribute('href')).toBe('/en/unified?view=starred')
    expect(active[0].getAttribute('title')).toBe('Starred')
  })
  it('clears every credential channel and address cache on logout', async () => {
    for (const key of ['userJwt', 'jwt', 'auth', 'adminAuth', 'addressPassword', 'userOauth2SessionState', 'userOauth2SessionClientID', 'unifiedApiKey']) context.state[key].value = 'credential'
    const host = await render()
    host.querySelector('button[aria-label="Sign out"]').click(); await nextTick()
    host.querySelector('section button').click(); await nextTick()
    for (const key of ['userJwt', 'jwt', 'auth', 'adminAuth', 'addressPassword', 'userOauth2SessionState', 'userOauth2SessionClientID', 'unifiedApiKey']) expect(context.state[key].value).toBe('')
    expect(context.clear).toHaveBeenCalledOnce()
    expect(context.push).toHaveBeenCalledWith('/en/')
  })
})
