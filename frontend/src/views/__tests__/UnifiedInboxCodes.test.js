import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const view = readFileSync(fileURLToPath(new URL('../UnifiedInbox.vue', import.meta.url)), 'utf8')

describe('UnifiedInbox verification codes aggregation contract', () => {
  it('allows loading verification codes without requiring codesAddr (unified aggregation)', () => {
    // There must be no early-return guard checking !codesAddr.value.trim() in loadCodes
    const loadCodesStart = view.indexOf('const loadCodes = async')
    const loadCodesEnd = view.indexOf('const copyCode = async', loadCodesStart)
    const loadCodesBody = view.slice(loadCodesStart, loadCodesEnd)

    expect(loadCodesBody).not.toContain('if (!codesAddr.value.trim())')
    expect(loadCodesBody).toContain('api.unified.verifcodes(codesAddr.value.trim(), codesFresh.value * 60 * 1000)')
  })

  it('triggers immediate loadCodes on activeTab switch to codes', () => {
    const watchTabStart = view.indexOf('watch(activeTab, (tab) => {')
    const watchTabEnd = view.indexOf('onMounted', watchTabStart)
    const watchTabBody = view.slice(watchTabStart, watchTabEnd)

    expect(watchTabBody).toContain("if (tab === 'codes')")
    expect(watchTabBody).toContain('loadCodes()')
    // Must not gate calling loadCodes on codesAddr.value.trim()
    expect(watchTabBody).not.toContain('if (codesAddr.value.trim())')
  })

  it('watches codesFresh and reloads codes when time window changes', () => {
    expect(view).toContain('watch(codesFresh, () => {')
    expect(view).toContain("if (activeTab.value === 'codes')")
    expect(view).toContain('loadCodes()')
  })

  it('allows auto-refresh for verification codes without requiring codesAddr', () => {
    const autoRefreshStart = view.indexOf('const autoRefreshList = () => {')
    const autoRefreshEnd = view.indexOf('const startAutoRefresh = () => {', autoRefreshStart)
    const autoRefreshBody = view.slice(autoRefreshStart, autoRefreshEnd)

    expect(autoRefreshBody).toContain("activeTab.value === 'codes'")
    expect(autoRefreshBody).not.toContain('codesAddr.value.trim()')
    expect(autoRefreshBody).toContain('void loadCodes({ background: true })')
  })

  it('renders recipient to_addr in code cards when present', () => {
    expect(view).toContain('{{ c.from_addr }} → {{ c.to_addr }}')
    expect(view).toContain('c.to_addr')
  })

  it('supports clearing the address filter to instantly return to all-account aggregation', () => {
    expect(view).toContain('@clear="loadCodes"')
  })
})
