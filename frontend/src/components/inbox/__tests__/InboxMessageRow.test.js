// @vitest-environment jsdom
import { createApp, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18N_MESSAGES } from '../../../i18n/messages'
import InboxMessageRow from '../InboxMessageRow.vue'
const mounted = []
afterEach(() => { for (const { app, host } of mounted.splice(0)) { app.unmount(); host.remove() } })
async function render(overrides = {}) {
  const host = document.createElement('div'); document.body.appendChild(host)
  const handlers = { onOpen: vi.fn(), onStar: vi.fn(), onRead: vi.fn(), onCopyCode: vi.fn() }
  const email = { id: 'one', from_addr: 'Team <team@example.com>', subject: 'A message', to_addr: 'me@example.com', is_read: 0, is_starred: 0, source: 'imap_gmail' }
  const app = createApp(InboxMessageRow, { email, ...handlers, ...overrides })
  app.use(createI18n({ legacy: false, locale: 'en', messages: I18N_MESSAGES }))
  app.mount(host); mounted.push({ app, host }); await nextTick(); return { host, handlers, email }
}
describe('InboxMessageRow', () => {
  it('offers a native keyboard-operable open button without nesting interactive elements', async () => {
    const { host, handlers } = await render()
    const button = host.querySelector('.inbox-message__open')
    expect(button.tagName).toBe('BUTTON')
    button.click()
    expect(handlers.onOpen).toHaveBeenCalledExactlyOnceWith('one')
    expect(host.querySelector('button button')).toBeNull()
  })
  it('does not open the message when starring, marking read or copying a code', async () => {
    const { host, handlers, email } = await render({ code: '482916' })
    host.querySelector('[aria-label="Add star"]').click()
    host.querySelector('[aria-label="Mark as read"]').click()
    host.querySelector('.inbox-code').click()
    expect(handlers.onStar).toHaveBeenCalledExactlyOnceWith(email)
    expect(handlers.onRead).toHaveBeenCalledExactlyOnceWith(email)
    expect(handlers.onCopyCode).toHaveBeenCalledExactlyOnceWith('482916')
    expect(handlers.onOpen).not.toHaveBeenCalled()
  })
  it('disables duplicate mutations while the existing write is in flight', async () => {
    const { host, handlers } = await render({ busy: true })
    host.querySelector('[aria-label="Add star"]').click()
    host.querySelector('[aria-label="Mark as read"]').click()
    expect(handlers.onStar).not.toHaveBeenCalled()
    expect(handlers.onRead).not.toHaveBeenCalled()
  })
  it('renders untrusted sender and subject as text and tolerates missing fields', async () => {
    const { host } = await render({ email: { id: 'unsafe', subject: '<img src=x onerror=alert(1)>' } })
    expect(host.querySelector('img')).toBeNull()
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>')
  })
})
