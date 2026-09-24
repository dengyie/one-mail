import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const detailView = readFileSync(fileURLToPath(new URL('../UnifiedInboxDetail.vue', import.meta.url)), 'utf8')
const inboxView = readFileSync(fileURLToPath(new URL('../UnifiedInbox.vue', import.meta.url)), 'utf8')
const apiIndex = readFileSync(fileURLToPath(new URL('../../api/index.js', import.meta.url)), 'utf8')

describe('Unified Inbox and Detail Auth Gateways', () => {
  it('UnifiedInboxDetail grants access when adminAuth is present', () => {
    // 必须从 useGlobalState 解构 adminAuth
    expect(detailView).toContain('adminAuth')
    expect(detailView).toMatch(/const\s*\{\s*[^}]*adminAuth[^}]*\}\s*=\s*useGlobalState\(\)/)

    // authIdentity 必须覆盖 userJwt、adminAuth、unifiedApiKey 三通道
    expect(detailView).toContain("const admin = adminAuth.value?.trim()")
    expect(detailView).toContain("if (admin) return `admin:${admin}`")
    expect(detailView).toContain('const hasAccess = computed(() => !!authIdentity.value)')
  })

  it('UnifiedInbox grants access when adminAuth is present', () => {
    // hasAdmin 必须覆盖 adminAuth 凭据
    expect(inboxView).toContain('const hasAdmin = computed(() => !!adminAuth.value?.trim())')
    expect(inboxView).toContain('const hasAccess = computed(() => isLoggedIn.value || hasKey.value || hasAdmin.value)')

    // authIdentity 必须包含 adminAuth 通道
    expect(inboxView).toContain("const admin = adminAuth.value?.trim()")
    expect(inboxView).toContain("if (admin) return `admin:${admin}`")
  })

  it('handleUnifiedUnauthorized clears adminAuth but does not force redirect to /user', () => {
    expect(apiIndex).toContain("const usedAdminChannel = Boolean(r?.config?.headers?.['x-admin-auth']);")
    expect(apiIndex).toContain("adminAuth.value = '';")
    // 管理密码失效时不跳转普通用户登录页，由视图内状态机原地展示密码卡片
    expect(apiIndex).toContain('// 管理密码失效时不跳转普通用户登录页，由视图内状态机原地展示密码卡片')
    expect(apiIndex).toMatch(/else if \(usedAdminChannel\) \{\s*adminAuth\.value = '';\s*\/\/[^\n]*\s*return;\s*\}/)
  })
})
