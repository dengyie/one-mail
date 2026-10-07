// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { ctx, email, deferred, flush, mount, mounts } from './unified-workspace-harness'
import UnifiedInbox from '../UnifiedInbox.vue'

const visible = () => Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })

describe('unified inbox quiet auto refresh contract', () => {
  it('enforces the 30-second floor and probes one row without a count', async () => {
    vi.useFakeTimers(); visible(); ctx.state.configAutoRefreshInterval.value = 5
    await mount(UnifiedInbox)
    await vi.advanceTimersByTimeAsync(29999)
    expect(ctx.api.unified.listEmails).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(ctx.api.unified.listEmails).toHaveBeenCalledTimes(2)
    expect(ctx.api.unified.listEmails.mock.calls[1][0]).toMatchObject({ limit: 1, with_count: 0 })
  })
  it('reschedules when the configured interval changes', async () => {
    vi.useFakeTimers(); visible(); await mount(UnifiedInbox)
    ctx.state.configAutoRefreshInterval.value = 60; await flush()
    await vi.advanceTimersByTimeAsync(30000)
    expect(ctx.api.unified.listEmails).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30000)
    expect(ctx.api.unified.listEmails).toHaveBeenCalledTimes(2)
  })
  it('reloads only when the newest mail changes', async () => {
    visible(); await mount(UnifiedInbox)
    document.dispatchEvent(new Event('visibilitychange')); await flush()
    expect(ctx.api.unified.listEmails).toHaveBeenCalledTimes(2)
    ctx.api.unified.listEmails.mockResolvedValue({ results: [email('mail-b')], count: 1 })
    document.dispatchEvent(new Event('visibilitychange')); await flush()
    expect(ctx.api.unified.listEmails).toHaveBeenCalledTimes(4)
    document.dispatchEvent(new Event('visibilitychange')); await flush()
    expect(ctx.api.unified.listEmails).toHaveBeenCalledTimes(5)
  })
  it('retains mail on refresh failure and retries the same new-mail boundary', async () => {
    visible(); const { host } = await mount(UnifiedInbox)
    ctx.api.unified.listEmails.mockResolvedValueOnce({ results: [email('new-mail')] }).mockRejectedValueOnce(new Error('offline'))
    document.dispatchEvent(new Event('visibilitychange')); await flush()
    expect(host.textContent).toContain('Private mail A')
    expect(ctx.api.unified.listEmails).toHaveBeenCalledTimes(3)
    ctx.api.unified.listEmails.mockResolvedValue({ results: [email('new-mail')], count: 2 })
    document.dispatchEvent(new Event('visibilitychange')); await flush()
    expect(ctx.api.unified.listEmails).toHaveBeenCalledTimes(5)
  })
  it('never starts refresh timers after unmount during options loading', async () => {
    vi.useFakeTimers(); visible(); const pending = deferred()
    ctx.api.unified.meta.mockReturnValue(pending.promise)
    const { unmount } = await mount(UnifiedInbox)
    unmount(); mounts.pop(); pending.resolve({}); await flush()
    await vi.advanceTimersByTimeAsync(60000)
    expect(ctx.api.unified.listEmails).not.toHaveBeenCalled()
  })
  it('pauses network reads while the document is hidden', async () => {
    vi.useFakeTimers(); await mount(UnifiedInbox)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await vi.advanceTimersByTimeAsync(60000)
    expect(ctx.api.unified.listEmails).toHaveBeenCalledTimes(1)
    visible(); document.dispatchEvent(new Event('visibilitychange')); await flush()
    expect(ctx.api.unified.listEmails).toHaveBeenCalledTimes(2)
  })
})

it('cancels reads when kept alive off-screen and resumes when activated', async () => {
  const { KeepAlive, defineComponent, h, ref } = await import('vue')
  const shown = ref(true)
  const Wrapper = defineComponent({ setup: () => () => h(KeepAlive, null, { default: () => shown.value ? h(UnifiedInbox) : null }) })
  const pending = deferred(); ctx.api.unified.listEmails.mockReturnValueOnce(pending.promise)
  await mount(Wrapper)
  const options = ctx.api.unified.listEmails.mock.calls[0][1]
  shown.value = false; await flush()
  expect(options.signal.aborted).toBe(true)
  pending.resolve({ results: [email('stale')] }); await flush()
  shown.value = true; await flush()
  expect(ctx.api.unified.listEmails).toHaveBeenCalledTimes(2)
})

it('recovers an incomplete page even when the newest mail has not changed', async () => {
  visible(); const { host } = await mount(UnifiedInbox)
  ctx.api.unified.listEmails.mockResolvedValueOnce({ results: [email()], count: null, degraded: ['shard-b'], next_cursor: null, has_more: true })
  host.querySelector('button[aria-label="Refresh mail"]').click(); await flush()
  document.dispatchEvent(new Event('visibilitychange')); await flush()
  expect(ctx.api.unified.listEmails).toHaveBeenCalledTimes(4)
  expect(host.textContent).not.toContain('shard-b')
})
