// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { ctx, email, mount } from './unified-workspace-harness.js'
import UnifiedInboxDetail from '../UnifiedInboxDetail.vue'

// Mail HTML keeps its <style> blocks (layout depends on them), so the body
// must not be injected into the light DOM: `body { ... }`, `div { ... }` or
// `* { ... }` in a mail would restyle the whole app.
const styledMail = () => ({
  ...email('mail-a'),
  is_read: 1,
  html_body: '<style>body{background:rgb(255,0,0)}div{color:rgb(0,255,0)}</style><p>Private mail A</p>',
})

describe('unified detail mail html isolation', () => {
  it('keeps the mail stylesheet out of the page document', async () => {
    ctx.api.unified.getEmail.mockResolvedValue(styledMail())

    const { host } = await mount(UnifiedInboxDetail)

    const mailRoot = host.querySelector('.mail-html')
    expect(mailRoot).not.toBeNull()
    expect(mailRoot.shadowRoot, 'mail body should render in a shadow root').not.toBeNull()
    expect(mailRoot.shadowRoot.textContent).toContain('Private mail A')
    // The mail's own stylesheet must survive -- moving it into the shadow tree
    // is what isolates it, stripping it would break the mail's layout.
    expect(mailRoot.shadowRoot.textContent).toContain('background:rgb(255,0,0)')

    const lightDomStyles = [...host.querySelectorAll('style')]
    expect(lightDomStyles.some(node => node.textContent.includes('background:rgb(255,0,0)'))).toBe(false)
  })
})
