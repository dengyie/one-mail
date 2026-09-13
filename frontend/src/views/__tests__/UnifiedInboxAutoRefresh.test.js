import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const view = readFileSync(fileURLToPath(new URL('../UnifiedInbox.vue', import.meta.url)), 'utf8')

describe('unified inbox quiet auto refresh contract', () => {
  it('refreshes the visible list every five seconds and cleans up lifecycle hooks', () => {
    expect(view).toContain('const AUTO_REFRESH_MS = 5000')
    expect(view).toContain("activeTab.value !== 'list'")
    expect(view).toContain("document.visibilityState !== 'visible'")
    expect(view).toContain('window.setInterval(autoRefreshList, AUTO_REFRESH_MS)')
    expect(view).toContain("document.addEventListener('visibilitychange', handleVisibilityChange)")
    expect(view).toContain('onBeforeUnmount(() => {')
    expect(view).toContain('stopAutoRefresh()')
    expect(view).toContain("document.removeEventListener('visibilitychange', handleVisibilityChange)")
  })

  it('uses a background mode that cannot overlap itself', () => {
    expect(view).toContain('let backgroundListPending = false')
    expect(view).toContain('const loadList = async ({ background = false } = {}) => {')
    expect(view).toContain('if (background && backgroundListPending) return')
    expect(view).toContain('void loadList({ background: true })')
  })

  it('keeps stale mail visible on a transient background failure', () => {
    const catchBlock = view.slice(
      view.indexOf('  } catch (e) {', view.indexOf('const loadList = async')),
      view.indexOf('  } finally {', view.indexOf('const loadList = async')),
    )
    expect(catchBlock).toContain('connected.value = false')
    expect(catchBlock).toContain('if (!background) {')
    expect(catchBlock).toContain("listError.value = e.message || 'error'")
    expect(catchBlock).toContain('emails.value = []')
    expect(catchBlock).toContain('count.value = 0')
  })

  it('keeps the existing manual refresh path', () => {
    expect(view).toContain('const refreshList = () => loadList()')
    expect(view).toContain('@click="refreshList"')
  })
})
