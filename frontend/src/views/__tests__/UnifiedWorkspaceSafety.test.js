// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { ctx, email, deferred, flush, mount, mounts, button } from './unified-workspace-harness'
import UnifiedInbox from '../UnifiedInbox.vue'
import UnifiedInboxDetail from '../UnifiedInboxDetail.vue'

describe('unified inbox isolation and lifecycle', () => {
  it('keeps healthy shard mail visible when the page is incomplete', async () => {
    ctx.api.unified.listEmails.mockResolvedValue({ results: [email()], count: null, degraded: ['shard-b'], next_cursor: null, has_more: true })
    const { host } = await mount(UnifiedInbox)
    expect(host.querySelectorAll('.inbox-message')).toHaveLength(1)
    expect(host.textContent).toContain('shard-b')
  })
  it('retains the displayed boundary during partial refresh, deduplicates, then replaces on recovery', async () => {
    ctx.api.unified.listEmails.mockResolvedValueOnce({ results: [email('old', 'Previously loaded')], count: 2, next_cursor: 'next', has_more: true })
    const { host } = await mount(UnifiedInbox)
    ctx.api.unified.listEmails.mockResolvedValue({ results: [{ ...email('healthy', 'Healthy shard'), account_id: 'account-b' }], count: null, incomplete: true, degraded: ['shard-a'], unavailable_mailbox_ids: ['account-a'], next_cursor: null, has_more: true })
    host.querySelector('button[aria-label="Refresh mail"]').click(); await flush()
    expect(host.textContent).toContain('Previously loaded')
    expect(host.textContent).toContain('Healthy shard')
    host.querySelector('button[aria-label="Refresh mail"]').click(); await flush()
    expect(host.querySelectorAll('.inbox-message')).toHaveLength(2)
    expect(host.querySelector('button[aria-label="Next page"]').disabled).toBe(true)
    ctx.api.unified.listEmails.mockResolvedValue({ results: [email('recovered', 'Recovered boundary')], count: 1, incomplete: false, next_cursor: null, has_more: false })
    host.querySelector('button[aria-label="Refresh mail"]').click(); await flush()
    expect(host.textContent).not.toContain('Previously loaded')
    expect(host.textContent).toContain('Recovered boundary')
    expect(ctx.api.unified.listEmails.mock.calls.at(-1)[0].cursor).toBeUndefined()
  })
  it('invalidates data when an attached admin credential is removed', async () => {
    ctx.state.adminAuth.value = 'admin-a'
    const { host } = await mount(UnifiedInbox)
    const pending = deferred()
    ctx.api.unified.listEmails.mockReturnValue(pending.promise)
    ctx.state.adminAuth.value = ''
    await flush()
    expect(host.textContent).not.toContain('Private mail A')
    expect(ctx.api.unified.listEmails).toHaveBeenCalledTimes(2)
  })
  it('does not fetch mail after unmount while options are pending', async () => {
    const pending = deferred(); ctx.api.unified.meta.mockReturnValue(pending.promise)
    const { unmount } = await mount(UnifiedInbox)
    unmount(); mounts.pop()
    pending.resolve({ sources: [], accounts: [], to_addrs: [] }); await flush()
    expect(ctx.api.unified.listEmails).not.toHaveBeenCalled()
  })
  it('keeps the refresh probe single-flight and cancels it on unmount', async () => {
    vi.useFakeTimers()
    const { unmount } = await mount(UnifiedInbox)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    const pending = deferred(); ctx.api.unified.listEmails.mockReturnValue(pending.promise)
    document.dispatchEvent(new Event('visibilitychange')); document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(ctx.api.unified.listEmails).toHaveBeenCalledTimes(2)
    const options = ctx.api.unified.listEmails.mock.calls[1][1]
    unmount(); mounts.pop()
    expect(options.signal.aborted).toBe(true)
    pending.resolve({ results: [email('mail-b')], count: 1 }); await flush()
    expect(ctx.api.unified.listEmails).toHaveBeenCalledTimes(2)
  })
  it('does not let an unapplied search draft affect the background probe', async () => {
    const { host } = await mount(UnifiedInbox)
    const input = host.querySelector('.inbox-search input')
    input.value = 'not submitted'; input.dispatchEvent(new Event('input', { bubbles: true })); await flush()
    document.dispatchEvent(new Event('visibilitychange')); await flush()
    const params = ctx.api.unified.listEmails.mock.calls.at(-1)[0]
    expect(params.q).toBeUndefined()
  })
})

describe('cursor pagination', () => {
  it('walks beyond 500 rows using cursors and no repeated count', async () => {
    ctx.api.unified.listEmails.mockImplementation(async params => {
      const index = Number(params.cursor?.split('-')[1] || 0)
      return { results: [email(`mail-${index}`)], count: index ? 0 : 800, next_cursor: `cursor-${index + 1}`, has_more: true }
    })
    const { host } = await mount(UnifiedInbox)
    expect(ctx.api.unified.listEmails.mock.calls[0][0].offset).toBeUndefined()
    for (let index = 1; index <= 27; index++) {
      const next = host.querySelector('button[aria-label="Next page"]')
      expect(next).not.toBeNull()
      next.click(); await flush()
      const params = ctx.api.unified.listEmails.mock.calls.at(-1)[0]
      expect(params.cursor).toBe(`cursor-${index}`)
      expect(params.offset).toBeUndefined()
      expect(params.with_count).toBe(0)
    }
    host.querySelector('button[aria-label="Previous page"]').click(); await flush()
    expect(ctx.api.unified.listEmails.mock.calls.at(-1)[0].cursor).toBe('cursor-26')
  })
  it('keeps a degraded cursor boundary retryable without advancing', async () => {
    ctx.api.unified.listEmails.mockResolvedValueOnce({ results: [email()], count: 60, next_cursor: 'boundary-a', has_more: true })
    const { host } = await mount(UnifiedInbox)
    ctx.api.unified.listEmails.mockResolvedValue({ results: [email('partial')], count: null, degraded: ['shard-b'], next_cursor: null, has_more: true })
    host.querySelector('button[aria-label="Next page"]').click(); await flush()
    expect(host.querySelector('button[aria-label="Next page"]').disabled).toBe(true)
    host.querySelector('button[aria-label="Refresh mail"]').click(); await flush()
    expect(ctx.api.unified.listEmails.mock.calls.at(-1)[0].cursor).toBe('boundary-a')
    expect(host.querySelectorAll('.inbox-message')).toHaveLength(1)
  })
})

describe('detail request lifecycle', () => {
  it('aborts reads on navigation and ignores old completions', async () => {
    const pending = deferred()
    ctx.api.unified.getEmail.mockReturnValueOnce(pending.promise)
    const { host, unmount } = await mount(UnifiedInboxDetail)
    const options = ctx.api.unified.getEmail.mock.calls[0][1]
    ctx.route.params.id = 'mail-b'; await flush()
    expect(options.signal.aborted).toBe(true)
    pending.resolve(email('mail-a', 'Stale detail')); await flush()
    expect(host.textContent).not.toContain('Stale detail')
    unmount(); mounts.pop()
  })
})

describe('mail overview safety', () => {
  it('renders untrusted mail as text without loading Markdown or HTML images', async () => {
    ctx.api.unified.getEmail.mockResolvedValue(email('mail-a', '![track](https://tracker.example/pixel)'))
    const { host } = await mount(UnifiedInboxDetail)
    button(host, 'Mail overview').click(); await flush()
    expect(host.querySelector('.mail-overview img[src^="https:"]')).toBeNull()
    expect(host.querySelector('.mail-overview').textContent).toContain('![track](https://tracker.example/pixel)')
  })
  it('does not reuse the previous credential scope\'s overview for the same mail ID', async () => {
    const { host } = await mount(UnifiedInboxDetail)
    button(host, 'Mail overview').click(); await flush()
    expect(host.querySelector('.mail-overview').textContent).toContain('Private mail A')
    ctx.api.unified.getEmail.mockResolvedValue(email('mail-a', 'Replacement mail B'))
    ctx.state.userJwt.value = 'user-b'; await flush()
    expect(host.querySelector('.mail-overview')?.textContent || '').not.toContain('Private mail A')
  })
})

describe('mutation ownership', () => {
  it('cancels pending row actions and suppresses completion toasts after unmount', async () => {
    const pending = deferred(); ctx.api.unified.toggleStar.mockReturnValue(pending.promise)
    const { host, unmount } = await mount(UnifiedInbox)
    host.querySelector('.inbox-message__actions button').click(); await flush()
    const options = ctx.api.unified.toggleStar.mock.calls[0][2]
    unmount(); mounts.pop()
    expect(options.signal.aborted).toBe(true)
    pending.resolve({ is_starred: 1 }); await flush()
    expect(ctx.messages.success).not.toHaveBeenCalled()
  })
  it('rolls back a failed row action and permits retry', async () => {
    ctx.api.unified.toggleStar.mockRejectedValueOnce(new Error('provider unavailable'))
    const { host } = await mount(UnifiedInbox)
    const star = host.querySelector('.inbox-message__actions button')
    star.click(); await flush()
    expect(star.getAttribute('aria-pressed')).toBe('false')
    expect(star.disabled).toBe(false)
    expect(ctx.messages.error).toHaveBeenCalledWith('provider unavailable')
    star.click(); await flush()
    expect(star.getAttribute('aria-pressed')).toBe('true')
  })
})

it('does not advertise ordinary English overview prose as a verification code', async () => {
  ctx.api.unified.getEmail.mockResolvedValue({ ...email(), text_body: 'PLEASE VERIFY DETAILS. Your deployment is ready.' })
  const { host } = await mount(UnifiedInboxDetail)
  button(host, 'Mail overview').click(); await flush()
  expect(host.querySelector('.mail-overview code')).toBeNull()
})

it('cannot restore an API credential after logout during key creation', async () => {
  ctx.route.query = { tab: 'settings' }
  const pending = deferred(); ctx.api.admin = { createUnifiedKey: vi.fn().mockReturnValue(pending.promise) }
  const { host } = await mount(UnifiedInbox)
  for (const [placeholder, value] of [['e.g. browser-dashboard', 'browser'], ['Required to create a key', 'admin-password']]) {
    const input = host.querySelector(`input[placeholder="${placeholder}"]`)
    input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  await flush(); button(host, 'Create').click(); await flush()
  expect(ctx.api.admin.createUnifiedKey).toHaveBeenCalledTimes(1)
  ctx.state.userJwt.value = ''; await flush()
  pending.resolve({ key: 'late-key' }); await flush()
  expect(ctx.state.unifiedApiKey.value).toBe('')
  expect(host.textContent).not.toContain('late-key')
})

describe('filtered mutation membership', () => {
  it.each(['starred', 'unread', 'combined'])('removes confirmed changes from a partial %s page while retaining unavailable mail', async view => {
    ctx.route.query = view === 'combined' ? { starred: '1', unread: '1' } : { view }
    const top = { ...email('top'), is_starred: 1 }
    const second = { ...email('second'), account_id: 'account-b', is_starred: 1 }
    const unavailable = { ...email('unavailable'), account_id: 'account-b', is_starred: 1 }
    const staleHealthy = { ...email('stale-healthy'), is_starred: 1 }
    ctx.api.unified.listEmails.mockResolvedValueOnce({ results: [top, second, unavailable, staleHealthy], count: 4, has_more: false })
      .mockResolvedValue({ results: [top], count: null, incomplete: true, degraded: ['shard-b'], unavailable_mailbox_ids: ['account-b'], next_cursor: null, has_more: true })
    ctx.api.unified.toggleStar.mockResolvedValue({ is_starred: 0 })
    ctx.api.unified.markRead.mockResolvedValue({ is_read: 1 })
    const { host } = await mount(UnifiedInbox)
    const action = view === 'unread' ? 'Mark as read' : 'Remove star'
    host.querySelector(`[data-mail-id="second"] button[aria-label="${action}"]`).click(); await flush()
    expect(ctx.api.unified.listEmails).toHaveBeenCalledTimes(2)
    expect(host.querySelector('[data-mail-id="unavailable"]')).not.toBeNull()
    expect(host.querySelector('[data-mail-id="second"]')).toBeNull()
    expect(host.querySelector('[data-mail-id="stale-healthy"]')).toBeNull()
    expect(host.querySelector('button[aria-label="Next page"]').disabled).toBe(true)
  })

  it('rolls back a rejected action on a row retained during a partial refresh', async () => {
    ctx.route.query = { view: 'starred' }
    ctx.api.unified.listEmails.mockResolvedValueOnce({ results: [{ ...email('pending'), is_starred: 1 }], count: 1, has_more: false })
      .mockResolvedValue({ results: [], count: null, incomplete: true, degraded: ['shard-a'], unavailable_mailbox_ids: ['account-a'], next_cursor: null, has_more: true })
    const pending = deferred()
    ctx.api.unified.toggleStar.mockReturnValue(pending.promise)
    const { host } = await mount(UnifiedInbox)
    host.querySelector('[data-mail-id="pending"] button[aria-label="Remove star"]').click(); await flush()
    host.querySelector('button[aria-label="Refresh mail"]').click(); await flush()
    pending.reject(new Error('provider refused')); await flush()
    expect(host.querySelector('[data-mail-id="pending"] button[aria-label="Remove star"]')).not.toBeNull()
    expect(ctx.messages.error).toHaveBeenCalledWith('provider refused')
  })

  it.each(['starred', 'unread', 'combined'])('reloads membership and count after changing a non-top %s row', async view => {
    ctx.route.query = view === 'combined' ? { starred: '1', unread: '1' } : { view }
    const top = { ...email('top'), is_starred: 1 }
    const second = { ...email('second'), is_starred: 1 }
    ctx.api.unified.listEmails.mockResolvedValueOnce({ results: [top, second], count: 2, has_more: false })
      .mockResolvedValue({ results: [top], count: 1, has_more: false })
    ctx.api.unified.toggleStar.mockResolvedValue({ is_starred: 0 })
    ctx.api.unified.markRead.mockResolvedValue({ is_read: 1 })
    const { host } = await mount(UnifiedInbox)
    const action = view === 'unread' ? 'Mark as read' : 'Remove star'
    host.querySelector(`[data-mail-id="second"] button[aria-label="${action}"]`).click(); await flush()
    expect(ctx.api.unified.listEmails).toHaveBeenCalledTimes(2)
    expect(ctx.api.unified.listEmails.mock.calls[1][0]).toMatchObject({ with_count: 1 })
    expect(host.querySelector('[data-mail-id="second"]')).toBeNull()
  })
})

it('invalidates old cursor boundaries and recounts when the last filtered row is removed', async () => {
  ctx.route.query = { view: 'starred' }
  ctx.api.unified.listEmails.mockResolvedValueOnce({ results: [{ ...email('first'), is_starred: 1 }], count: 2, has_more: true, next_cursor: 'page-two' })
    .mockResolvedValueOnce({ results: [{ ...email('last'), is_starred: 1 }], count: 0, has_more: false })
    .mockResolvedValue({ results: [], count: 0, has_more: false })
  ctx.api.unified.toggleStar.mockResolvedValue({ is_starred: 0 })
  const { host } = await mount(UnifiedInbox)
  host.querySelector('button[aria-label="Next page"]').click(); await flush()
  host.querySelector('[data-mail-id="last"] button[aria-label="Remove star"]').click(); await flush()
  const params = ctx.api.unified.listEmails.mock.calls.at(-1)[0]
  expect(params.cursor).toBeUndefined()
  expect(params.with_count).toBe(1)
  expect(host.querySelectorAll('[data-mail-id]')).toHaveLength(0)
  expect(host.querySelector('button[aria-label="Previous page"]')?.disabled ?? true).toBe(true)
})

it('keeps a filtered row and pagination unchanged when the provider rejects the mutation', async () => {
  ctx.route.query = { view: 'starred' }
  ctx.api.unified.listEmails.mockResolvedValue({ results: [{ ...email('first'), is_starred: 1 }], count: 2, has_more: true, next_cursor: 'page-two' })
  ctx.api.unified.toggleStar.mockRejectedValue(new Error('provider refused'))
  const { host } = await mount(UnifiedInbox)
  host.querySelector('[data-mail-id="first"] button[aria-label="Remove star"]').click(); await flush()
  expect(ctx.api.unified.listEmails).toHaveBeenCalledTimes(1)
  expect(host.querySelector('[data-mail-id="first"] button[aria-label="Remove star"]')).not.toBeNull()
  expect(host.querySelector('button[aria-label="Next page"]').disabled).toBe(false)
})

it.each(['succeeded', 'failed'])('keeps an unread action pending until provider %s', async status => {
  const { createUnifiedMutationApi } = await import('../../utils/unified-provider-mutations')
  const pending = deferred()
  const request = vi.fn().mockResolvedValueOnce({ status: 'queued', job_id: 'j-unread' }).mockReturnValueOnce(pending.promise)
  Object.assign(ctx.api.unified, createUnifiedMutationApi({ request, getAuth: () => ({ key: 'user-a', headers: {} }) }))
  ctx.api.unified.listEmails.mockResolvedValue({ results: [{ ...email(), is_read: 1 }], count: 1 })
  const { host } = await mount(UnifiedInbox)
  host.querySelector('button[aria-label="Mark as unread"]').click(); await flush()
  expect(host.querySelector('button[aria-label="Mark as read"]').disabled).toBe(true)
  pending.resolve({ status, desired_value: 0, error: status === 'failed' ? 'provider refused' : null }); await flush()
  const label = status === 'succeeded' ? 'Mark as read' : 'Mark as unread'
  expect(host.querySelector(`button[aria-label="${label}"]`).disabled).toBe(false)
  if (status === 'failed') expect(ctx.messages.error).toHaveBeenCalledWith('provider refused')
})
