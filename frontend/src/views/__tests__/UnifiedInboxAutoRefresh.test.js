import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const view = readFileSync(fileURLToPath(new URL('../UnifiedInbox.vue', import.meta.url)), 'utf8')

describe('unified inbox quiet auto refresh contract', () => {
  it('polls at the configured interval with a quota floor, never a hardcoded 5s', () => {
    // 5s 硬编码轮询曾在每次刷新时附带 COUNT(*) 全表扫描，烧穿 D1 rows_read 免费额度
    expect(view).not.toContain('AUTO_REFRESH_MS')
    expect(view).not.toContain('= 5000')
    expect(view).toContain('const refreshIntervalMs = computed(() => (')
    expect(view).toContain(
      'Math.max(MIN_AUTO_REFRESH_INTERVAL, Number(configAutoRefreshInterval.value) || MIN_AUTO_REFRESH_INTERVAL) * 1000',
    )
    expect(view).toContain('window.setInterval(autoRefreshList, refreshIntervalMs.value)')
    expect(view).toContain('watch(refreshIntervalMs, () => {')
  })

  it('probes a single row with with_count=0 before any background reload', () => {
    expect(view).toContain('const probeNewestKey = async () => {')
    expect(view).toContain('{ ...filterParams.value, limit: 1, offset: 0, with_count: 0 }')
    expect(view).not.toContain('void loadList({ background: true })')
  })

  it('only reloads the list when the newest email actually changed', () => {
    expect(view).toContain('const emailSortKey = (row)')
    expect(view).toContain('let newestSeenKey = ')
    expect(view).toContain('const hasNew = newestKey !== newestSeenKey')
    expect(view).toContain('newestSeenKey = newestKey')
    expect(view).toContain('if (hasNew && !backgroundListPending) {')
    expect(view).toContain('newestSeenKey = emailSortKey(emails.value[0])')
  })

  it('resets the probe baseline when the auth identity changes', () => {
    const watchBlock = view.slice(
      view.indexOf('watch(authIdentity,'),
      view.indexOf('watch(autoRefresh,'),
    )
    expect(watchBlock).toContain("newestSeenKey = ''")
  })

  it('uses a background mode that cannot overlap itself', () => {
    expect(view).toContain('let backgroundListPending = false')
    expect(view).toContain('const loadList = async ({ background = false } = {}) => {')
    expect(view).toContain('if (background && backgroundListPending) return')
    expect(view).toContain('await loadList({ background: true })')
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

  it('cannot register a timer after an async mount has already been disposed', () => {
    expect(view).toContain('let componentDisposed = false')
    expect(view).toContain('if (componentDisposed) return')
    expect(view).toContain('componentDisposed = true')
    expect(view).toContain('listRequestSeq += 1')
  })

  it('keeps the existing manual refresh path and page lifecycle cleanup', () => {
    expect(view).toContain('const refreshList = () => loadList()')
    expect(view).toContain('@click="refreshList"')
    expect(view).toContain("activeTab.value !== 'list'")
    expect(view).toContain("document.visibilityState !== 'visible'")
    expect(view).toContain("document.addEventListener('visibilitychange', handleVisibilityChange)")
    expect(view).toContain('onBeforeUnmount(() => {')
    expect(view).toContain('stopAutoRefresh()')
    expect(view).toContain("document.removeEventListener('visibilitychange', handleVisibilityChange)")
  })

  it('handles keep-alive lifecycle by pausing onDeactivated and resuming onActivated', () => {
    expect(view).toContain('onActivated(() => {')
    expect(view).toContain('if (isFirstMount) return')
    expect(view).toContain('startAutoRefresh()')
    expect(view).toContain('autoRefreshList()')
    expect(view).toContain('onDeactivated(() => {')
    expect(view).toContain('stopAutoRefresh()')
  })
})
