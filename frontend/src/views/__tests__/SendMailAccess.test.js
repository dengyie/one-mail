import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const sendMailView = readFileSync(fileURLToPath(new URL('../index/SendMail.vue', import.meta.url)), 'utf8')

describe('SendMail access control contracts', () => {
  it('defines administrator exemption for email sending permission', () => {
    // 必须引入 adminAuth 并计算管理员身份
    expect(sendMailView).toContain('const { settings, sendMailModel, userSettings, userJwt, adminAuth } = useGlobalState()')
    expect(sendMailView).toContain('const isAdmin = computed(() => Boolean(userSettings.value?.is_admin || adminAuth.value))')
    expect(sendMailView).toContain('const hasSendPermission = computed(() => isAdmin.value || (settings.value.send_balance && settings.value.send_balance > 0))')
  })

  it('gates the send composition form on hasSendPermission and shows unlimited quota for admins', () => {
    // 拦截卡片由 hasSendPermission 控制，而非盲信 settings.send_balance
    expect(sendMailView).toContain('v-if="!hasSendPermission"')
    expect(sendMailView).toContain('v-else class="space-y-4"')
    // 管理员展示无限额度提示
    expect(sendMailView).toContain('管理员无限额度')
  })
})
