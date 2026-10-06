import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const view = readFileSync(fileURLToPath(new URL('../index/SendWorkbench.vue', import.meta.url)), 'utf8')

describe('send workbench phase D contracts', () => {
  it('keeps self/system source split and excludes OTP from the system tab', () => {
    expect(view).toContain("const SYSTEM_SOURCES = 'user_api,external_api,smtp_proxy,admin'")
    expect(view).toContain("if (activeTab.value === 'system') return SYSTEM_SOURCES")
    expect(view).toContain('return SELF_SOURCES')
    expect(view).not.toContain('system_otp')
  })

  it('shows self/system tab badges from sendbox counts', () => {
    expect(view).toContain("const SELF_SOURCES = 'user_ui,external_account'")
    expect(view).toContain('`/api/sendbox?source=${SELF_SOURCES}&limit=1&offset=0`')
    expect(view).toContain('`/api/sendbox?source=${SYSTEM_SOURCES}&limit=1&offset=0`')
    expect(view).toContain(':value="selfCount"')
    expect(view).toContain(':value="systemCount"')
    expect(view).toContain(':show="selfCount > 0"')
    expect(view).toContain(':show="systemCount > 0"')
  })

  it('probes badge newest-id with with_count=0 and only recounts on change', () => {
    expect(view).toContain('`/api/sendbox?source=${SELF_SOURCES}&limit=1&offset=0&with_count=0`')
    expect(view).toContain('`/api/sendbox?source=${SYSTEM_SOURCES}&limit=1&offset=0&with_count=0`')
    expect(view).toContain('void probeBadges()')
    expect(view).toContain('if (changed)')
    expect(view).toContain('await loadBadges()')
  })

  it('refreshes badges on an interval and cleans up lifecycle hooks', () => {
    expect(view).toContain('const BADGE_REFRESH_MS = 30000')
    expect(view).toContain('window.setInterval(')
    expect(view).toContain("document.addEventListener('visibilitychange', handleVisibilityChange)")
    expect(view).toContain('onBeforeUnmount(() => {')
    expect(view).toContain('stopBadgeRefresh()')
    expect(view).toContain("document.removeEventListener('visibilitychange', handleVisibilityChange)")
  })

  it('passes auto-refresh to the history pane without extracting compose from SendMail.vue', () => {
    expect(view).toContain(':auto-refresh="autoRefresh && showHistory"')
    expect(view).toContain('import SendMail from \'./SendMail.vue\'')
  })
})
