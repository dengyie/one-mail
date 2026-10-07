// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { ctx, flush, mount } from './unified-workspace-harness'
import UnifiedInbox from '../UnifiedInbox.vue'
import UnifiedInboxDetail from '../UnifiedInboxDetail.vue'

describe('Unified Inbox and Detail Auth Gateways', () => {
  it.each([UnifiedInbox, UnifiedInboxDetail])('permits admin-only reads and erases mail on logout', async View => {
    ctx.state.userJwt.value = ''; ctx.state.adminAuth.value = 'admin-only'
    const { host } = await mount(View)
    expect(host.textContent).toContain('Private mail A')
    ctx.state.adminAuth.value = ''; await flush()
    expect(host.textContent).not.toContain('Private mail A')
  })
  it.each([UnifiedInbox, UnifiedInboxDetail])('permits standalone API-key reads', async View => {
    ctx.state.userJwt.value = ''; ctx.state.unifiedApiKey.value = 'read-key'
    const { host } = await mount(View)
    expect(host.textContent).toContain('Private mail A')
  })
})
