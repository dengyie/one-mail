// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick } from 'vue'
import ShadowHtmlComponent from '../ShadowHtmlComponent.vue'

const mail = '<style>body{background:rgb(255,0,0)}</style><p>Private mail A</p>'
const mounts = []
const flush = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
    await nextTick()
  }
}

async function mount(props) {
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(ShadowHtmlComponent, props)
  app.mount(host)
  mounts.push(() => { app.unmount(); host.remove() })
  await flush()
  return host
}

afterEach(() => { mounts.splice(0).forEach(unmount => unmount()) })

describe('ShadowHtmlComponent', () => {
  it('renders the mail stylesheet inside the shadow root only', async () => {
    const host = await mount({ htmlContent: mail })

    const root = host.firstElementChild
    expect(root.shadowRoot).not.toBeNull()
    expect(root.shadowRoot.textContent).toContain('Private mail A')
    expect(root.shadowRoot.textContent).toContain('background:rgb(255,0,0)')
    expect(host.querySelector('style')).toBeNull()
  })

  it('drops the mail stylesheet when shadow DOM is unavailable', async () => {
    const original = Element.prototype.attachShadow
    Object.defineProperty(Element.prototype, 'attachShadow', { value: undefined, configurable: true })
    try {
      const host = await mount({ htmlContent: mail })

      expect(host.textContent).toContain('Private mail A')
      expect(host.querySelector('style')).toBeNull()
      expect(host.textContent).not.toContain('background:rgb(255,0,0)')
    } finally {
      Object.defineProperty(Element.prototype, 'attachShadow', { value: original, configurable: true })
    }
  })
})
