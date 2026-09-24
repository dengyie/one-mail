import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const sidebar = readFileSync(fileURLToPath(new URL('../AppSidebar.vue', import.meta.url)), 'utf8')

describe('AppSidebar access control contracts', () => {
  it('strictly restricts canUseDomainMailbox to administrator identities and excludes disableAdminPasswordCheck', () => {
    // 权限计算：严格限定管理员角色、管理密码、或独立管理员 API Key
    expect(sidebar).toContain('const canUseDomainMailbox = computed(() =>')
    expect(sidebar).toContain('userSettings.value.is_admin ||')
    expect(sidebar).toContain('adminAuth.value ||')
    expect(sidebar).toContain('(unifiedApiKey.value && !hasUserSession.value)')

    // 杜绝 disableAdminPasswordCheck 假阳性开关造成与工作台及后端 API 鉴权规则分裂
    expect(sidebar).not.toContain('openSettings.value.disableAdminPasswordCheck')
  })

  it('renders domain-mailbox button with Catch-All tag and allows container entry for admin credentials', () => {
    expect(sidebar).toContain('v-if="hasAddressSession || hasUserSession || canUseDomainMailbox"')
    expect(sidebar).toContain('v-if="canUseDomainMailbox"')
    expect(sidebar).toContain("@click=\"handleNavigate('/domain-mailbox')\"")
    expect(sidebar).toContain('Catch-All')
    expect(sidebar).toContain('域名邮箱 · 全域')
  })
})
