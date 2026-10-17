import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const simpleIndexView = readFileSync(fileURLToPath(new URL('../index/SimpleIndex.vue', import.meta.url)), 'utf8')
const mailboxView = readFileSync(fileURLToPath(new URL('../../components/MailBox.vue', import.meta.url)), 'utf8')

describe('SimpleIndex & MailBox auto refresh interval contracts', () => {
  it('drives SimpleIndex countdown and refresh interval from configAutoRefreshInterval', () => {
    expect(simpleIndexView).toContain('configAutoRefreshInterval')
    expect(simpleIndexView).toContain('const currentAutoRefreshInterval = ref(Number(configAutoRefreshInterval.value) || 10)')
    expect(simpleIndexView).toContain('currentAutoRefreshInterval.value = Number(configAutoRefreshInterval.value) || 10')
    expect(simpleIndexView).toContain('watch(configAutoRefreshInterval, (newInterval) => {')
    expect(simpleIndexView).not.toContain('currentAutoRefreshInterval.value = 60')
  })

  it('drives MailBox reactive update when configAutoRefreshInterval changes', () => {
    expect(mailboxView).toContain('watch([autoRefresh, configAutoRefreshInterval]')
  })

  it('pauses and resumes MailBox timer on keep-alive deactivation and activation', () => {
    expect(mailboxView).toContain('onActivated(async () => {')
    expect(mailboxView).toContain('if (isFirstMount) return')
    expect(mailboxView).toContain('setupAutoRefresh(true)')
    expect(mailboxView).toContain('onDeactivated(() => {')
    expect(mailboxView).toContain('clearInterval(timer.value)')
  })

  it('MailBox skips COUNT(*) on background auto-refresh and pauses while hidden', () => {
    expect(mailboxView).toContain('const refresh = async ({ background = false } = {}) => {')
    expect(mailboxView).toContain('{ withCount: !background }')
    expect(mailboxView).toContain('await refresh({ background: true })')
    expect(mailboxView).toContain("document.visibilityState !== 'visible') return;")
    expect(mailboxView).toContain("document.addEventListener('visibilitychange', onVisibilityChange)")
    expect(mailboxView).toContain("document.removeEventListener('visibilitychange', onVisibilityChange)")
    // 返回的 count 为 null 时必须保留旧总数，不能把「没算」读成「空邮箱」
    expect(mailboxView).toContain("typeof totalCount === 'number' && Number.isFinite(totalCount) && totalCount >= 0")
    // 服务端只在 offset 0 算总数，第 2 页的 0/null 不能覆盖首页总数
    expect(mailboxView).toContain('if (page.value === 1 && typeof totalCount')
  })

  it('SimpleIndex background refresh is cheap and quiet, and pauses while hidden', () => {
    expect(simpleIndexView).toContain('&with_count=${withCount ? 1 : 0}')
    expect(simpleIndexView).toContain('fetchMails({ withCount: !background })')
    expect(simpleIndexView).toContain("if (!background) message.success(t('refreshSuccess'))")
    expect(simpleIndexView).toContain("document.visibilityState !== 'visible') return")
    expect(simpleIndexView).toContain("document.addEventListener('visibilitychange', onVisibilityChange)")
    expect(simpleIndexView).toContain("document.removeEventListener('visibilitychange', onVisibilityChange)")
    // null count 不能覆盖已有总数
    expect(simpleIndexView).toContain("typeof count === 'number' && Number.isFinite(count) && count >= 0")
  })
})
