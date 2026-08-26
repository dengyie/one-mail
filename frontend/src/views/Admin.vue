<script setup>
import { useMessage } from 'naive-ui'
import { computed, onMounted, ref, defineAsyncComponent } from 'vue';
import { useScopedI18n } from '@/i18n/app'
import { useRouter } from 'vue-router'

import { useGlobalState } from '../store'
import { api } from '../api'
import { getRouterPathWithLang, hashPassword } from '../utils'
import { clearLocalAddressCache } from '../utils/address-cache'
import Turnstile from '../components/Turnstile.vue'

import SenderAccess from './admin/SenderAccess.vue'
import Statistics from "./admin/Statistics.vue"
import SendBox from './admin/SendBox.vue';
import Account from './admin/Account.vue';
import CreateAccount from './admin/CreateAccount.vue';
import AccountSettings from './admin/AccountSettings.vue';
import UserManagement from './admin/UserManagement.vue';
import UserSettings from './admin/UserSettings.vue';
import UserOauth2Settings from './admin/UserOauth2Settings.vue';
import RoleAddressConfig from './admin/RoleAddressConfig.vue';
import Mails from './admin/Mails.vue';
import MailsUnknow from './admin/MailsUnknow.vue';
import About from './common/About.vue';
import Maintenance from './admin/Maintenance.vue';
import DatabaseManager from './admin/DatabaseManager.vue';
import Appearance from './common/Appearance.vue';
import Telegram from './admin/Telegram.vue';
import Webhook from './admin/Webhook.vue';
import MailWebhook from './admin/MailWebhook.vue';
import WorkerConfig from './admin/WorkerConfig.vue';
import IpBlacklistSettings from './admin/IpBlacklistSettings.vue';
import AiExtractSettings from './admin/AiExtractSettings.vue';

const {
  adminAuth, showAdminAuth, adminTab, loading,
  globalTabplacement, showAdminPage, adminLoginMode, userSettings,
  openSettings, auth, jwt, userJwt,
  userOauth2SessionState, userOauth2SessionClientID,
  addressPassword, unifiedApiKey
} = useGlobalState()
const message = useMessage()
const router = useRouter()

const SendMail = defineAsyncComponent(() => {
  loading.value = true;
  return import('./admin/SendMail.vue')
    .finally(() => loading.value = false);
});

const cfToken = ref('')
const turnstileRef = ref(null)

const authFunc = async () => {
  try {
    await api.fetch('/open_api/admin_login', {
      method: 'POST',
      body: JSON.stringify({
        password: await hashPassword(tmpAdminAuth.value),
        cf_token: cfToken.value
      })
    });
    adminAuth.value = tmpAdminAuth.value;
    location.reload()
  } catch (error) {
    message.error(error.message || "error");
    turnstileRef.value?.refresh?.();
  }
}

const showLogoutModal = ref(false)

const handleLogout = async () => {
  // 清空管理员认证
  adminAuth.value = '';
  // 清空全部鉴权凭据（C3：退出登录后不清会残留在 localStorage，共享设备可继续操作）
  auth.value = '';
  jwt.value = '';
  userJwt.value = '';
  addressPassword.value = '';
  userOauth2SessionState.value = '';
  userOauth2SessionClientID.value = '';
  // 一并清除统一收件箱 API key（共享设备凭据残留）
  unifiedApiKey.value = '';
  // H5：清除 store 之外的 LocalAddressCache（地址 JWT 缓存，防共享设备残留）
  clearLocalAddressCache();
  // 重置管理员相关状态
  showAdminAuth.value = false;
  adminTab.value = 'account';
  // 显示成功提示并跳转
  message.success(t('logoutSuccess'));
  await router.push(getRouterPathWithLang('/', locale.value));
}

const { t, locale } = useScopedI18n('views.Admin')

const showAdminPasswordModal = computed(() => !showAdminPage.value || showAdminAuth.value)
const tmpAdminAuth = ref('')
// 判断是否通过 admin password 登录（而非用户管理员权限）：消费 store 单源 adminLoginMode
const isAdminPasswordLogin = computed(() => adminLoginMode.value === 'admin')

// 获取当前登录方式：三态判定集中于 store 的 adminLoginMode（单源），组件仅做文案映射
const currentLoginMethod = computed(() => {
  switch (adminLoginMode.value) {
    case 'admin':
      return t('loginViaPassword');
    case 'user_admin':
      return t('loginViaUserAdmin');
    case 'disabled_check':
      return t('loginViaDisabledCheck');
    default:
      return '';
  }
})

onMounted(async () => {
  // make sure openSettings is fetched for turnstile check
  if (!openSettings.value.fetched) await api.getOpenSettings(message);
  // make sure user_id is fetched
  if (!userSettings.value.user_id) await api.getUserSettings(message);
})
</script>

<template>
  <div v-if="userSettings.fetched" class="space-y-6">
    <n-modal v-model:show="showAdminPasswordModal" :closable="false" :closeOnEsc="false" :maskClosable="false"
      preset="dialog" :title="t('accessHeader')" class="rounded-3xl">
      <p class="text-sm text-slate-500 mb-3">{{ t('accessTip') }}</p>
      <n-input v-model:value="tmpAdminAuth" type="password" show-password-on="click" @keyup.enter="authFunc" class="rounded-xl mb-3" />
      <Turnstile ref="turnstileRef" v-if="openSettings.enableGlobalTurnstileCheck" v-model:value="cfToken" />
      <template #action>
        <n-button @click="authFunc" type="primary" :loading="loading" class="rounded-xl px-4">
          {{ t('ok') }}
        </n-button>
      </template>
    </n-modal>
    
    <div v-if="showAdminPage" class="bg-white/90 dark:bg-slate-900/90 backdrop-blur-xl rounded-3xl border border-slate-200/80 dark:border-slate-800/80 p-4 sm:p-6 shadow-sm">
      <n-tabs type="segment" animated v-model:value="adminTab" class="mb-4">
        <n-tab-pane name="qucickSetup" :tab="t('qucickSetup')">
          <div class="pt-2">
            <n-tabs type="bar" justify-content="center" animated>
              <n-tab-pane name="database" :tab="t('database')">
                <DatabaseManager />
              </n-tab-pane>
              <n-tab-pane name="account_settings" :tab="t('account_settings')">
                <AccountSettings />
              </n-tab-pane>
              <n-tab-pane name="user_settings" :tab="t('user_settings')">
                <UserSettings />
              </n-tab-pane>
              <n-tab-pane name="workerconfig" :tab="t('workerconfig')">
                <WorkerConfig />
              </n-tab-pane>
            </n-tabs>
          </div>
        </n-tab-pane>
        <n-tab-pane name="account" :tab="t('account')">
          <div class="pt-2">
            <n-tabs type="bar" justify-content="center" animated>
              <n-tab-pane name="account" :tab="t('account')">
                <Account />
              </n-tab-pane>
              <n-tab-pane name="account_create" :tab="t('account_create')">
                <CreateAccount />
              </n-tab-pane>
              <n-tab-pane name="account_settings" :tab="t('account_settings')">
                <AccountSettings />
              </n-tab-pane>
              <n-tab-pane name="senderAccess" :tab="t('senderAccess')">
                <SenderAccess />
              </n-tab-pane>
              <n-tab-pane name="ipBlacklistSettings" :tab="t('ipBlacklistSettings')">
                <IpBlacklistSettings />
              </n-tab-pane>
              <n-tab-pane name="aiExtractSettings" :tab="t('aiExtractSettings')">
                <AiExtractSettings />
              </n-tab-pane>
              <n-tab-pane name="webhook" :tab="t('webhookSettings')">
                <Webhook />
              </n-tab-pane>
            </n-tabs>
          </div>
        </n-tab-pane>
        <n-tab-pane name="user" :tab="t('user')">
          <div class="pt-2">
            <n-tabs type="bar" justify-content="center" animated>
              <n-tab-pane name="user_management" :tab="t('user_management')">
                <UserManagement />
              </n-tab-pane>
              <n-tab-pane name="user_settings" :tab="t('user_settings')">
                <UserSettings />
              </n-tab-pane>
              <n-tab-pane name="userOauth2Settings" :tab="t('userOauth2Settings')">
                <UserOauth2Settings />
              </n-tab-pane>
              <n-tab-pane name="roleAddressConfig" :tab="t('roleAddressConfig')">
                <RoleAddressConfig />
              </n-tab-pane>
            </n-tabs>
          </div>
        </n-tab-pane>
        <n-tab-pane name="mails" :tab="t('mails')">
          <div class="pt-2">
            <n-tabs type="bar" justify-content="center" animated>
              <n-tab-pane name="mails" :tab="t('mails')">
                <Mails />
              </n-tab-pane>
              <n-tab-pane name="unknow" :tab="t('unknow')">
                <MailsUnknow />
              </n-tab-pane>
              <n-tab-pane name="sendBox" :tab="t('sendBox')">
                <SendBox />
              </n-tab-pane>
              <n-tab-pane name="sendMail" :tab="t('sendMail')">
                <SendMail />
              </n-tab-pane>
              <n-tab-pane name="mailWebhook" :tab="t('mailWebhook')">
                <MailWebhook />
              </n-tab-pane>
            </n-tabs>
          </div>
        </n-tab-pane>
        <n-tab-pane name="telegram" :tab="t('telegram')">
          <div class="pt-2">
            <Telegram />
          </div>
        </n-tab-pane>
        <n-tab-pane name="statistics" :tab="t('statistics')">
          <div class="pt-2">
            <Statistics />
          </div>
        </n-tab-pane>
        <n-tab-pane name="maintenance" :tab="t('maintenance')">
          <div class="pt-2">
            <n-tabs type="bar" justify-content="center" animated>
              <n-tab-pane name="database" :tab="t('database')">
                <DatabaseManager />
              </n-tab-pane>
              <n-tab-pane name="workerconfig" :tab="t('workerconfig')">
                <WorkerConfig />
              </n-tab-pane>
              <n-tab-pane name="maintenance" :tab="t('maintenance')">
                <Maintenance />
              </n-tab-pane>
            </n-tabs>
          </div>
        </n-tab-pane>
        <n-tab-pane name="appearance" :tab="t('appearance')">
          <div class="pt-2">
            <Appearance />
          </div>
        </n-tab-pane>
        <n-tab-pane name="adminAccount" :tab="t('adminAccount')">
          <div class="flex justify-center p-6">
            <div class="w-full max-w-lg p-6 bg-slate-50 dark:bg-slate-800/60 rounded-2xl border border-slate-200 dark:border-slate-700/60">
              <n-space vertical size="large">
                <div>
                  <div class="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">{{ t('loginMethod') }}</div>
                  <div class="text-sm font-bold text-slate-800 dark:text-white">{{ currentLoginMethod }}</div>
                </div>
                <n-divider v-if="isAdminPasswordLogin" />
                <n-button v-if="isAdminPasswordLogin" type="warning" @click="showLogoutModal = true" block class="rounded-xl font-medium">
                  {{ t('logout') }}
                </n-button>
              </n-space>
            </div>
          </div>
        </n-tab-pane>
        <n-tab-pane name="about" :tab="t('about')">
          <div class="pt-2">
            <About />
          </div>
        </n-tab-pane>
      </n-tabs>
    </div>
    <n-modal v-model:show="showLogoutModal" preset="dialog" :title="t('logoutConfirmTitle')" class="rounded-2xl">
      <p>{{ t('logoutConfirmContent') }}</p>
      <template #action>
        <n-button :loading="loading" @click="handleLogout" size="small" tertiary type="warning" class="rounded-xl">
          {{ t('confirm') }}
        </n-button>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.n-pagination {
  margin-top: 10px;
  margin-bottom: 10px;
}
</style>
