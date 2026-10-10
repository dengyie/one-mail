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
    expect(source).toContain('d1Quotas || (d1Quota ? [d1Quota] : [])')
  })

  it('labels each card with its shard id and warns when a shard is unreachable', () => {
    expect(source).toContain('quota.shard_id')
    expect(source).toContain("t('d1QuotaUnreachable')")
    expect(source).toContain('!quota.reachable')
  })

  it('shows the registry-assigned accounts only when they are known', () => {
    expect(source).toContain('v-if="quota.accounts_known"')
    expect(source).toContain("t('d1QuotaAccounts'")
    expect(source).toContain('quota.account_ids.length')
  })
})
