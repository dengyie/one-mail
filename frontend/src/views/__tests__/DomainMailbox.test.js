import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const view = readFileSync(fileURLToPath(new URL('../DomainMailbox.vue', import.meta.url)), 'utf8')

describe('DomainMailbox view contract and performance optimizations', () => {
  it('implements lifecycle disposal protection to prevent async timer leaks', () => {
    expect(view).toContain('let componentDisposed = false')
    expect(view).toContain('if (componentDisposed) return')
    expect(view).toContain('onBeforeUnmount(() => {')
    expect(view).toContain('componentDisposed = true')
    expect(view).toContain('stopTimer()')
  })

  it('protects D1 read quota with Page Visibility API check during auto-refresh', () => {
    expect(view).toContain("document.visibilityState !== 'visible'")
    expect(view).toContain("document.addEventListener('visibilitychange', handleVisibilityChange)")
    expect(view).toContain("document.removeEventListener('visibilitychange', handleVisibilityChange)")
    expect(view).toContain("document.visibilityState === 'visible'")
  })

  it('guards against request race conditions in loading states', () => {
    expect(view).toContain('let listRequestSeq = 0')
    expect(view).toContain('const requestId = ++listRequestSeq')
    expect(view).toContain('if (requestId !== listRequestSeq || componentDisposed) return')
    expect(view).toContain('else if (requestId === listRequestSeq) {')
    expect(view).toContain('loading.value = false')

    // Codes request also has sequential requestId race guard
    expect(view).toContain('let codesRequestSeq = 0')
    expect(view).toContain('const requestId = ++codesRequestSeq')
    expect(view).toContain('else if (requestId === codesRequestSeq) {')
    expect(view).toContain('codesLoading.value = false')
  })

  it('drives query refresh strictly through computed listSignature to prevent watch storms', () => {
    expect(view).toContain('const listParams = computed(() => ({')
    expect(view).toContain('const listSignature = computed(() => JSON.stringify(listParams.value))')
    expect(view).toContain('watch(listSignature, () => {')
    expect(view).toContain("nextCursor.value = ''")
    expect(view).toContain('refreshAll()')
  })

  it('implements debounced search query to eliminate keystroke-level network floods', () => {
    expect(view).toContain("const searchQuery = ref('')")
    expect(view).toContain("const debouncedSearch = ref('')")
    expect(view).toContain('let searchDebounceTimer = null')
    expect(view).toContain('searchDebounceTimer = setTimeout(() => {')
    expect(view).toContain('300')
    expect(view).toContain('if (searchDebounceTimer) clearTimeout(searchDebounceTimer)')
  })

  it('supports random prefix generation for instant disposable address creation', () => {
    expect(view).toContain('const generateRandomPrefix = () => {')
    expect(view).toContain('🎲 随机')
  })

  it('displays to_addr and provides one-click recipient address filtering', () => {
    expect(view).toContain('row.to_addr')
    expect(view).toContain('filterByAddress(row.to_addr)')
    expect(view).toContain('const filterByAddress = (targetAddr) => {')
    expect(view).toContain("const [prefix, d] = targetAddr.split('@')")
    expect(view).toContain('addressOnly.value = true')
  })

  it('offers selectable time windows for verification code aggregation', () => {
    expect(view).toContain('const codeFreshnessMinutes = ref(10)')
    expect(view).toContain("label: '10分钟', value: 10")
    expect(view).toContain("label: '1小时', value: 60")
    expect(view).toContain("label: '24小时', value: 1440")
    expect(view).toContain('codeFreshnessMinutes.value * 60 * 1000')
  })

  it('preserves navigation context by passing origin in query', () => {
    expect(view).toContain("query: { from: '/domain-mailbox' }")
    expect(view).toContain('getRouterPathWithLang')
  })

  it('supports inline star toggling with optimistic update', () => {
    expect(view).toContain('const toggleStar = async (row, event) => {')
    expect(view).toContain('api.unified.toggleStar(row.id, nextVal)')
  })
})
