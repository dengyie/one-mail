import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The dashboard must render one D1 quota card per database. The backend returns
// d1Quotas (primary first) and keeps the single-object d1Quota for older
// responses, so the view has to iterate the list and fall back to the object.
const source = readFileSync(
  fileURLToPath(new URL('../Statistics.vue', import.meta.url)),
  'utf8',
)

describe('admin statistics D1 quota per-database cards', () => {
  it('renders one card per entry in d1Quotas', () => {
    expect(source).toContain('v-for="quota in statistics.d1Quotas"')
    expect(source).not.toContain('v-if="statistics.d1Quota"')
  })

  it('falls back to the single-object d1Quota for older responses', () => {
    expect(source).toContain('Array.isArray(d1Quotas) && d1Quotas.length')
    expect(source).toContain('if (!d1Quota) return []')
    // The legacy object predates reachable/account_ids, so they are defaulted.
    expect(source).toContain('reachable: true')
  })

  it('spans the full grid row when there is a single database', () => {
    expect(source).toContain("statistics.d1Quotas.length === 1 ? 'sm:col-span-3' : ''")
  })

  it('labels each card with its shard id and warns when a shard is unreachable', () => {
    expect(source).toContain('quota.shard_id')
    expect(source).toContain("t('d1QuotaUnreachable')")
    expect(source).toContain('!quota.reachable')
    expect(source).toContain('quota.unavailable_reason')
  })

  it('never renders a numeric percentage for an unreachable database', () => {
    // The percentage is only shown inside the reachable branch; the unknown
    // case renders a dash instead of a fabricated 0%.
    expect(source).toContain('<template v-if="quota.reachable">{{ quota.rows_read_pct }}')
    expect(source).toContain('— / —')
  })

  it('shows the registry-assigned accounts only when they are known', () => {
    expect(source).toContain('v-if="quota.accounts_known"')
    expect(source).toContain("t('d1QuotaAccounts'")
    expect(source).toContain('quota.account_ids.length')
    expect(source).toContain("t('d1QuotaAccountsPrimary')")
  })

  it('surfaces accounting issues on a reachable database', () => {
    expect(source).toContain("t('d1QuotaIssues'")
    expect(source).toContain('quota.accounting_issues?.length')
  })
})
