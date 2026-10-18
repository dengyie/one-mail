// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AttachmentManagement from '../AttachmentManagement.vue'

const { listEmails, downloadAttachment, message } = vi.hoisted(() => ({
  listEmails: vi.fn(),
  downloadAttachment: vi.fn(),
  message: { error: vi.fn() },
}))
vi.mock('@/api', () => ({ api: { unified: { listEmails, downloadAttachment } } }))
vi.mock('@/i18n/app', () => ({ useScopedI18n: () => ({ t: key => key, locale: { value: 'en' } }) }))
vi.mock('@/utils', () => ({ getRouterPathWithLang: path => path }))
vi.mock('../../../components/ui/MailIcon.vue', () => ({ default: { render: () => h('span') } }))
vi.mock('../../../components/ui/WorkspaceEmpty.vue', () => ({
  default: {
    props: ['title', 'description'],
    setup: (props, { slots }) => () => h('div', { class: 'workspace-empty' }, [props.title, slots.default?.()]),
  },
}))
vi.mock('naive-ui', async importOriginal => ({
  ...await importOriginal(),
  useMessage: () => message,
}))

const mounted = []
const email = (attachments = [{ id: 'att-1', name: 'report.txt', size: 12, downloadable: true }]) => ({
  id: 'mail-1',
  from_addr: 'sender@example.com',
  to_addr: 'admin@example.com',
  subject: 'Quarterly report',
  received_at: 1_797_000_000_000,
  attachments_json: JSON.stringify(attachments),
})
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); await nextTick() }
const button = (host, label) => [...host.querySelectorAll('button')].find(el => el.textContent.trim() === label)

const buttonStub = {
  props: ['attrType', 'disabled', 'loading'],
  setup: (props, { slots, attrs }) => () => h('button', {
    type: props.attrType || 'button',
    disabled: props.disabled,
    'aria-label': attrs['aria-label'],
    onClick: attrs.onClick,
  }, slots.default?.()),
}
const stubs = {
  'n-button': buttonStub,
  'n-input': {
    props: ['value', 'inputProps', 'placeholder'],
    emits: ['update:value', 'clear'],
    setup: (props, { emit, slots }) => () => h('label', [
      slots.prefix?.(),
      h('input', {
        value: props.value,
        placeholder: props.placeholder,
        'aria-label': props.inputProps?.['aria-label'],
        onInput: event => emit('update:value', event.target.value),
      }),
    ]),
  },
  'n-alert': { setup: (_, { slots }) => () => h('div', { class: 'alert' }, slots.default?.()) },
  'n-skeleton': { render: () => h('div') },
  'n-tag': { setup: (_, { slots }) => () => h('span', slots.default?.()) },
  RouterLink: { setup: (_, { slots }) => () => h('a', slots.default?.()) },
}

async function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(AttachmentManagement)
  for (const [name, component] of Object.entries(stubs)) app.component(name, component)
  app.mount(host)
  const unmount = () => { app.unmount(); host.remove() }
  mounted.push(unmount)
  await flush()
  return { host, unmount }
}

beforeEach(() => {
  vi.clearAllMocks()
  listEmails.mockReset()
  downloadAttachment.mockReset()
  message.error.mockReset()
})
afterEach(() => { for (const unmount of mounted.splice(0)) unmount() })
afterEach(() => vi.unstubAllGlobals())

describe('attachment list', () => {
  it('requests only attachment mail without a count and follows the opaque cursor', async () => {
    listEmails.mockResolvedValueOnce({ results: [email()], has_more: true, next_cursor: 'cursor-next' })
      .mockResolvedValueOnce({ results: [email()], has_more: false, next_cursor: null })
    const { host } = await mount()
    expect(listEmails.mock.calls[0][0]).toMatchObject({ has_attachments: 1, limit: 20, with_count: 0 })
    expect(listEmails.mock.calls[0][0].cursor).toBeUndefined()

    button(host, 'list.next').click()
    await flush()
    expect(listEmails.mock.calls[1][0]).toMatchObject({ has_attachments: 1, cursor: 'cursor-next', with_count: 0 })
    expect(host.textContent).toContain('Quarterly report')
  })

  it('shows an error with retry instead of presenting a failed read as empty', async () => {
    listEmails.mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce({ results: [], has_more: false })
    const { host } = await mount()
    expect(host.textContent).toContain('database unavailable')
    expect(host.querySelector('.workspace-empty')).toBeNull()

    button(host, 'retry').click()
    await flush()
    expect(host.querySelector('.workspace-empty')).not.toBeNull()
    expect(listEmails).toHaveBeenCalledTimes(2)
  })
})

describe('attachment download', () => {
  it('exposes downloads only for downloadable metadata and uses the authenticated API', async () => {
    listEmails.mockResolvedValue({
      results: [email([
        { id: 'att-1', name: 'report.txt', size: 12, downloadable: true },
        { id: 'att-2', name: 'old.txt', size: 4, downloadable: false },
      ])],
      has_more: false,
    })
    const blob = new Blob(['file'])
    downloadAttachment.mockResolvedValue({ blob, headers: { 'content-disposition': 'attachment; filename="report.txt"' } })
    const createObjectURL = vi.fn().mockReturnValue('blob:attachment-test')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    const clicked = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      clicked.push({ href: this.href, download: this.download })
    })
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(callback => { callback(); return 0 })

    const { host } = await mount()
    const downloads = [...host.querySelectorAll('button')].filter(el => el.textContent.trim() === 'detail.download')
    expect(downloads).toHaveLength(1)
    downloads[0].click()
    await flush()

    expect(downloadAttachment).toHaveBeenCalledExactlyOnceWith('mail-1', 'att-1', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(createObjectURL).toHaveBeenCalledExactlyOnceWith(blob)
    expect(clicked).toEqual([{ href: 'blob:attachment-test', download: 'report.txt' }])
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:attachment-test')
    timer.mockRestore()
  })
})
