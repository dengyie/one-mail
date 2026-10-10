<script setup>
import MailIcon from '../components/ui/MailIcon.vue'
import { useMessage } from 'naive-ui'
import { computed, onMounted, ref } from 'vue'
import { useScopedI18n } from '@/i18n/app'
import { useRoute, useRouter } from 'vue-router'

import { useGlobalState } from '../store'
import { api } from '../api'
import { getRouterPathWithLang, hashPassword } from '../utils'
import Turnstile from '../components/Turnstile.vue'

import SenderAccess from './admin/SenderAccess.vue'
import Statistics from "./admin/Statistics.vue"
import SendBox from './admin/SendBox.vue'
import Account from './admin/Account.vue'
import CreateAccount from './admin/CreateAccount.vue'
import AccountSettings from './admin/AccountSettings.vue'
import UserManagement from './admin/UserManagement.vue'
import UserSettings from './admin/UserSettings.vue'
import UserOauth2Settings from './admin/UserOauth2Settings.vue'
import RoleAddressConfig from './admin/RoleAddressConfig.vue'
import Mails from './admin/Mails.vue'
import MailsUnknow from './admin/MailsUnknow.vue'
import About from './common/About.vue'
import Maintenance from './admin/Maintenance.vue'
import DatabaseManager from './admin/DatabaseManager.vue'
import Appearance from './common/Appearance.vue'
import Telegram from './admin/Telegram.vue'
import Webhook from './admin/Webhook.vue'
import MailWebhook from './admin/MailWebhook.vue'
import WorkerConfig from './admin/WorkerConfig.vue'
import IpBlacklistSettings from './admin/IpBlacklistSettings.vue'
import AiExtractSettings from './admin/AiExtractSettings.vue'
import AdminSendMail from './admin/SendMail.vue'
import UnknownSendMail from './admin/UnknownSendMail.vue'

const {
  adminAuth, adminTab, loading,
  showAdminPage, adminLoginMode, userSettings,
  openSettings, userJwt
} = useGlobalState()
const message = useMessage()
const route = useRoute()
const router = useRouter()

const { t, locale } = useScopedI18n('views.Admin')

const cfToken = ref('')
const turnstileRef = ref(null)
const tmpAdminAuth = ref('')

const authFunc = async () => {
  try {
    await api.fetch('/open_api/admin_login', {
      method: 'POST',
      body: JSON.stringify({
        password: await hashPassword(tmpAdminAuth.value),
        cf_token: cfToken.value
      })
    })
    adminAuth.value = tmpAdminAuth.value
    location.reload()
  } catch (error) {
    message.error(error.message || "error")
    turnstileRef.value?.refresh?.()
  }
}

// 映射路由子段到具体展示模块
const currentAdminView = computed(() => {
  const p = route.path
  if (p.includes('/admin/users')) return 'users'
  if (p.includes('/admin/statistics')) return 'statistics'
  if (p.includes('/admin/ai-extract')) return 'ai_extract'
  if (p.includes('/admin/webhook')) return 'webhook'
  if (p.includes('/admin/database')) return 'database'
  if (p.includes('/admin/settings')) return 'settings'
  if (p.includes('/admin/sender-access')) return 'sender_access'
  if (p.includes('/admin/sendmail')) return 'send_mail'
  if (p.includes('/admin/sendbox')) return 'send_box'
  if (p.includes('/admin/send-unknown')) return 'send_unknown'
  if (p.includes('/admin/accounts')) return 'accounts'
  
  // 兼容根据 store adminTab 渲染
  if (adminTab.value === 'user_management') return 'users'
  if (adminTab.value === 'statistics') return 'statistics'
  if (adminTab.value === 'ai_extract') return 'ai_extract'
  if (adminTab.value === 'webhook') return 'webhook'
  if (adminTab.value === 'database_manager') return 'database'
  if (adminTab.value === 'account_settings') return 'settings'
  if (adminTab.value === 'sender_access') return 'sender_access'
  if (adminTab.value === 'send_mail') return 'send_mail'
  if (adminTab.value === 'sendBox') return 'send_box'
  if (adminTab.value === 'sendUnknown') return 'send_unknown'
  return 'accounts'
})

onMounted(async () => {
  if (!openSettings.value.fetched) await api.getOpenSettings(message)
  if (!userSettings.value.user_id) await api.getUserSettings(message)
})
</script>

<template>
  <div v-if="userSettings.fetched" class="space-y-6">
    <!-- 1. 普通用户直接拦截 -->
    <div v-if="userJwt && !userSettings.is_admin" class="p-8 bg-white/90 dark:bg-slate-900/90 rounded-3xl border border-slate-200/80 dark:border-slate-800/80 text-center max-w-md mx-auto my-12 shadow-sm">
      <div class="w-16 h-16 rounded-full bg-rose-500/10 text-rose-500 flex items-center justify-center mx-auto mb-4 text-2xl font-bold">
        <MailIcon name="shield" :size="25" />
      </div>
<h3 class="text-lg font-bold text-slate-900 dark:text-white">{{ t('noAdminTitle') }}</h3>
      <p class="text-xs text-slate-500 mt-2">{{ t('noAdminTip') }}</p>
      <n-button @click="router.push(getRouterPathWithLang('/unified', locale))" type="primary" secondary class="mt-6 rounded-xl">
        {{ t('backToInbox') }}
      </n-button>
    </div>

    <!-- 2. 未登录访客密码弹窗 -->
    <div v-else-if="!adminAuth" class="p-8 bg-white/90 dark:bg-slate-900/90 rounded-3xl border border-slate-200/80 dark:border-slate-800/80 max-w-md mx-auto my-12 shadow-sm text-center">
      <div class="w-14 h-14 rounded-2xl bg-amber-500/10 text-amber-500 flex items-center justify-center mx-auto mb-4 text-2xl">
        <MailIcon name="key" :size="25" />
      </div>
      <h3 class="text-lg font-bold text-slate-900 dark:text-white mb-2">{{ t('adminAccessTitle') }}</h3>
      <p class="text-xs text-slate-500 mb-6">{{ t('accessTip') }}</p>
      <n-input v-model:value="tmpAdminAuth" type="password" show-password-on="click" :placeholder="t('adminPasswordPlaceholder')" @keyup.enter="authFunc" class="rounded-xl mb-4 text-left" />
      <Turnstile ref="turnstileRef" v-if="openSettings.enableGlobalTurnstileCheck" v-model:value="cfToken" class="mb-4" />
      <n-button @click="authFunc" type="primary" block :loading="loading" class="rounded-xl font-medium">
        {{ t('ok') }}
      </n-button>
    </div>

    <!-- 3. 管理员授权通过，直接呈现纯粹内容视图（零内嵌顶部大 Banner/Tabs） -->
    <div v-else class="space-y-6">
      
      <!-- 邮箱账户管理模块 -->
      <div v-if="currentAdminView === 'accounts'" class="settings-section space-y-6">
        <div class="workspace-page-header">
          <div>
            <h2 class="text-xl font-bold text-slate-900 dark:text-white tracking-tight">{{ t('accountsTitle') }}</h2>
            <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{{ t('accountsSubtitle') }}</p>
          </div>
        </div>
        <Account />
      </div>

      <!-- 用户列表管理模块 -->
      <div v-else-if="currentAdminView === 'users'" class="settings-section space-y-6">
        <div class="workspace-page-header">
          <div>
            <h2 class="text-xl font-bold text-slate-900 dark:text-white tracking-tight">{{ t('usersTitle') }}</h2>
            <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{{ t('usersSubtitle') }}</p>
          </div>
        </div>
        <UserManagement />
      </div>

      <!-- 统计分析模块 -->
      <div v-else-if="currentAdminView === 'statistics'" class="space-y-6">
        <div class="flex items-center justify-between pb-2 border-b border-slate-200/80 dark:border-slate-800/80">
          <div>
            <h2 class="text-xl font-bold text-slate-900 dark:text-white tracking-tight">{{ t('statisticsTitle') }}</h2>
            <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{{ t('statisticsSubtitle') }}</p>
          </div>
        </div>
        <Statistics />
      </div>

      <!-- AI 提取规则配置模块 -->
      <div v-else-if="currentAdminView === 'ai_extract'" class="settings-section space-y-6">
        <div class="workspace-page-header">
          <div>
            <h2 class="text-xl font-bold text-slate-900 dark:text-white tracking-tight">{{ t('aiExtractTitle') }}</h2>
            <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{{ t('aiExtractSubtitle') }}</p>
          </div>
        </div>
        <AiExtractSettings />
      </div>

      <!-- Webhook 与事件通知模块 -->
      <div v-else-if="currentAdminView === 'webhook'" class="settings-section space-y-6">
        <div class="workspace-page-header">
          <div>
            <h2 class="text-xl font-bold text-slate-900 dark:text-white tracking-tight">{{ t('webhookTitle') }}</h2>
            <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{{ t('webhookSubtitle') }}</p>
          </div>
        </div>
        <Webhook />
      </div>

      <!-- 数据库与维护模块 -->
      <div v-else-if="currentAdminView === 'database'" class="settings-section space-y-6">
        <div class="workspace-page-header">
          <div>
            <h2 class="text-xl font-bold text-slate-900 dark:text-white tracking-tight">{{ t('databaseTitle') }}</h2>
            <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{{ t('databaseSubtitle') }}</p>
          </div>
        </div>
        <DatabaseManager />
      </div>

      <!-- 域名与系统全局设置模块 -->
      <div v-else-if="currentAdminView === 'settings'" class="settings-section space-y-6">
        <div class="workspace-page-header">
          <div>
            <h2 class="text-xl font-bold text-slate-900 dark:text-white tracking-tight">{{ t('settingsTitle') }}</h2>
            <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{{ t('settingsSubtitle') }}</p>
          </div>
        </div>
        <AccountSettings />
      </div>

      <!-- 发信权限与配额审批模块 -->
      <div v-else-if="currentAdminView === 'sender_access'" class="settings-section space-y-6">
        <div class="workspace-page-header">
          <div>
            <h2 class="text-xl font-bold text-slate-900 dark:text-white tracking-tight">{{ t('senderAccessTitle') }}</h2>
            <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{{ t('senderAccessSubtitle') }}</p>
          </div>
        </div>
        <SenderAccess />
      </div>

      <!-- 管理员直接外发邮件模块 -->
      <div v-else-if="currentAdminView === 'send_mail'" class="settings-section space-y-6">
        <div class="workspace-page-header">
          <div>
            <h2 class="text-xl font-bold text-slate-900 dark:text-white tracking-tight">{{ t('sendMailTitle') }}</h2>
            <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{{ t('sendMailSubtitle') }}</p>
          </div>
        </div>
        <AdminSendMail />
      </div>

      <!-- 全站出站记录 -->
      <div v-else-if="currentAdminView === 'send_box'" class="settings-section space-y-6">
        <div class="workspace-page-header">
          <div>
            <h2 class="text-xl font-bold text-slate-900 dark:text-white tracking-tight">{{ t('sendBoxTitle') }}</h2>
            <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{{ t('sendBoxSubtitle') }}</p>
          </div>
        </div>
        <SendBox />
      </div>

      <!-- 未知投递 -->
      <div v-else-if="currentAdminView === 'send_unknown'" class="settings-section space-y-6">
        <div class="workspace-page-header">
          <div>
            <h2 class="text-xl font-bold text-slate-900 dark:text-white tracking-tight">{{ t('sendUnknownTitle') }}</h2>
            <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{{ t('sendUnknownSubtitle') }}</p>
          </div>
        </div>
        <UnknownSendMail />
      </div>

    </div>
  </div>
</template>
