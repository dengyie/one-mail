// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { ctx, flush, mount, button } from './unified-workspace-harness'
import UnifiedInbox from '../UnifiedInbox.vue'

describe('UnifiedInbox verification codes aggregation contract', () => {
  it('loads all-account codes immediately when the tab opens and displays their recipient', async () => {
    ctx.api.unified.verifcodes.mockResolvedValue({ results: [{ code: '123456', from_addr: 'sender@example.com', to_addr: 'alias@example.com', received_at: 1791334800000 }] })
    const { host } = await mount(UnifiedInbox)
    ctx.route.query = { tab: 'codes' }; await flush()
    expect(ctx.api.unified.verifcodes).toHaveBeenCalledWith('', 600000, undefined, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(host.textContent).toContain('alias@example.com')
  })
  it('allows manual and visibility refresh without an address filter', async () => {
    ctx.route.query = { tab: 'codes' }
    const { host } = await mount(UnifiedInbox)
    ctx.api.unified.verifcodes.mockClear()
    const refresh = [...host.querySelectorAll('button')].find(node => node.textContent.trim() === 'Refresh')
    expect(refresh).toBeDefined(); refresh.click(); await flush()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange')); await flush()
    expect(ctx.api.unified.verifcodes).toHaveBeenCalledTimes(2)
    expect(ctx.api.unified.verifcodes.mock.calls[1][0]).toBe('')
  })
})

it('keeps partial code cards visible and identifies the unavailable shard', async () => {
  ctx.route.query = { tab: 'codes' }
  ctx.api.unified.verifcodes.mockResolvedValue({ results: [{ code: '123456', to_addr: 'alias@example.com' }], degraded: ['shard-b'] })
  const { host } = await mount(UnifiedInbox)
  expect(host.textContent).toContain('123456')
  expect(host.textContent).toContain('shard-b')
})
