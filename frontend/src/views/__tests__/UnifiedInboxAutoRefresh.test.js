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
  it('never asks for the total on background reloads, only on the foreground load', async () => {
    visible(); await mount(UnifiedInbox)
    // 首屏是前台加载：page 1 显式要总数。
    expect(ctx.api.unified.listEmails.mock.calls[0][0]).toMatchObject({ with_count: 1 })

    // 探测到新邮件后触发的是后台重载，必须不再跑全表 COUNT(*)。
    ctx.api.unified.listEmails.mockResolvedValue({ results: [email('mail-c')], count: 9 })
    document.dispatchEvent(new Event('visibilitychange')); await flush()

    const backgroundReloads = ctx.api.unified.listEmails.mock.calls
      .map(call => call[0])
      .filter(params => params && params.limit !== 1)
      .slice(1)
    expect(backgroundReloads.length).toBeGreaterThan(0)
    for (const params of backgroundReloads) expect(params).toMatchObject({ with_count: 0 })
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
  it('returns to the first page before a background reload so a page 2 poll still shows the arrival', async () => {
    vi.useFakeTimers(); visible()
    // 同一个 mock 同时服务探测（limit: 1）和列表（limit: 20），按 cursor 分页。
    const arrival = email('mail-new', 'Freshly arrived mail')
    let newest = email('mail-top', 'Newest known mail')
    ctx.api.unified.listEmails.mockImplementation(async params => {
      if (params.limit === 1) return { results: [newest], count: null }
      if (params.cursor === 'cursor-1') return { results: [email('mail-21', 'Second page tail')], count: null, next_cursor: null, has_more: false }
      return { results: [newest, email('mail-20', 'Second newest mail')], count: null, next_cursor: 'cursor-1', has_more: true }
    })
    const { host } = await mount(UnifiedInbox)

    // 停在第 2 页：precondition，后台重载会沿用这一页的 cursor。
    host.querySelector('button[aria-label="Next page"]').click(); await flush()
    expect(ctx.api.unified.listEmails.mock.calls.at(-1)[0].cursor).toBe('cursor-1')

    // 新邮件到达，探测开始返回新的首行。
    newest = arrival
    await vi.advanceTimersByTimeAsync(30000); await flush()

    // 回归契约：后台重载之前必须先 resetPagination()，把用户带回第一页。
    // 少了这一行，后台重载会带着 cursor-1 继续取第 2 页的旧切片，新邮件刷不出来，
    // 而 newestSeenKey 仍然按探测 key 推进 —— 下一个 tick 就判定「无变化」，
    // 这次到达被静默吞掉：没有报错、没有重试、基线也不会退回。
    const lastListCall = ctx.api.unified.listEmails.mock.calls
      .map(call => call[0])
      .filter(params => params && params.limit !== 1)
      .at(-1)
    expect(lastListCall.cursor).toBeUndefined()
    // 用户真的看见了新邮件，而不只是浪费了一次请求。
    expect(host.textContent).toContain('Freshly arrived mail')
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
