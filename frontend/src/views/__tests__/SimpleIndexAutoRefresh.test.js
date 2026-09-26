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
})
