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

  it('permits administrators to view and access sendmail/sendbox and exposes admin sender management tools', () => {
    // 侧边栏允许管理员在未激活临时地址会话时访问发送邮件入口
    expect(sidebar).toContain('const isAdmin = computed(() => Boolean(userSettings.value.is_admin || adminAuth.value))')
    expect(sidebar).toContain('v-if="(hasAddressSession || isAdmin) && openSettings.enableSendMail"')

    // 管理员系统中心中暴露发信权限管理与管理员发信入口
    expect(sidebar).toContain("handleNavigate('/admin/sender-access')")
    expect(sidebar).toContain('发信权限管理')
    expect(sidebar).toContain("handleNavigate('/admin/sendmail')")
    expect(sidebar).toContain('管理员专属发信')
  })
})
