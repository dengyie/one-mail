import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const pane = readFileSync(fileURLToPath(new URL('../SendHistoryPane.vue', import.meta.url)), 'utf8')
const sendBox = readFileSync(fileURLToPath(new URL('../SendBox.vue', import.meta.url)), 'utf8')

describe('send history auto-refresh and provider id contracts', () => {
  it('refreshes quietly every 15 seconds without remounting SendBox', () => {
    expect(pane).toContain('const AUTO_REFRESH_MS = 15000')
    expect(pane).toContain('window.setInterval(autoRefreshList, AUTO_REFRESH_MS)')
    expect(pane).toContain("document.addEventListener('visibilitychange', handleVisibilityChange)")
    expect(pane).toContain('onBeforeUnmount(() => {')
    expect(pane).toContain('stopAutoRefresh()')
    expect(pane).toContain(':quiet-refresh-key="quietRefreshKey"')
    expect(pane).not.toContain(':key="`${endpoint}-${source}-${address}-${refreshKey}-${queryVersion}-${quietRefreshKey}`"')
  })

  it('probes newest sendbox id with with_count=0 before quiet reload', () => {
    // 服务端总数已改为显式 opt-in，所以两种路径都必须显式带参，不能依赖默认值。
    expect(pane).toContain("params.set('with_count', withCount ? '1' : '0')")
    expect(pane).toContain('withCount: false')
    expect(pane).toContain('probeNewestKey')
    expect(pane).toContain('if (newestKey !== newestSeenKey)')
    expect(pane).toContain("params.set('channel', channelFilter.value)")
    expect(pane).not.toContain('results.filter((row) => row.channel === channelFilter.value)')
  })

  it('cannot overlap a quiet refresh and keeps the current page', () => {
    expect(sendBox).toContain('let refreshPending = false')
    expect(sendBox).toContain('if (refreshPending) return')
    expect(sendBox).toContain('watch(() => props.quietRefreshKey')
    expect(sendBox).toContain('await refresh({ quiet: true })')
    expect(sendBox).toContain('if (!quiet)')
    expect(sendBox).toContain('pageSize.value, (page.value - 1) * pageSize.value')
  })

  it('shows provider_message_id from columns or raw JSON', () => {
    expect(sendBox).toContain('item.provider_message_id = item.provider_message_id || data.provider_message_id || null')
    expect(sendBox).toContain("historyT('providerId')")
    expect(sendBox).toContain('row.provider_message_id')
    expect(sendBox).toContain('curMail.provider_message_id')
  })
})
