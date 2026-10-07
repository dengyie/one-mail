<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useScopedI18n } from '@/i18n/app'
import { useGlobalState } from '../../store'
import { api } from '../../api'
import PromptChips from '../../components/ai/PromptChips.vue'
import StatusIndicator from '../../components/ai/StatusIndicator.vue'
import SendHistoryPane from '../../components/SendHistoryPane.vue'
import SendMail from './SendMail.vue'

const SYSTEM_SOURCES = 'user_api,external_api,smtp_proxy,admin'
// 本人发出的邮件：既含默认临时地址（user_ui），也含以已接入外部邮箱身份
// 发出的邮件（external_account，见 docs/send-mail-external-accounts.md §5.3）。
const SELF_SOURCES = 'user_ui,external_account'
const VALID_TABS = ['compose', 'self', 'system']

const route = useRoute()
const router = useRouter()
const { t } = useScopedI18n('views.index.SendWorkbench')
const { settings, userSettings, adminAuth, jwt, openSettings } = useGlobalState()

const BADGE_REFRESH_MS = 30000

const initializing = ref(true)
const showAll = ref(false)
const historyKey = ref(0)
const selfCount = ref(0)
const systemCount = ref(0)
const autoRefresh = ref(true)
let badgeTimer = null
let badgePending = false
let componentDisposed = false
let selfNewestKey = ''
let systemNewestKey = ''

const isAdmin = computed(() => Boolean(userSettings.value?.is_admin || adminAuth.value))
const hasAddress = computed(() => Boolean(settings.value?.address && jwt.value))

const activeTab = computed({
  get() {
    const tab = Array.isArray(route.query.tab) ? route.query.tab[0] : route.query.tab
    return VALID_TABS.includes(tab) ? tab : 'compose'
  },
  set(value) {
    router.replace({
      query: {
        ...route.query,
        tab: value,
      },
    })
  },
})

const chips = computed(() => [
  t('chipCompose'),
  t('chipSelf'),
  t('chipSystem'),
  t('chipAll'),
  t('chipRefresh'),
])

const historySource = computed(() => {
  if (showAll.value) return ''
  if (activeTab.value === 'system') return SYSTEM_SOURCES
  return SELF_SOURCES
})

const historyEmpty = computed(() => {
  if (showAll.value) return t('emptyAll')
  if (activeTab.value === 'system') return t('emptySystem')
  return t('emptySelf')
})

const showHistory = computed(() => showAll.value || activeTab.value !== 'compose')

const connStatus = computed(() => {
  if (initializing.value) return 'connecting'
  if (hasAddress.value) return 'online'
  return 'offline'
})

const connLabel = computed(() => {
  if (initializing.value) return t('statusLoading')
  if (hasAddress.value) return t('statusReady')
  return t('statusNoAddress')
})

const onTabUpdate = (value) => {
  showAll.value = false
  activeTab.value = value
}

const handleSelectChip = (item) => {
  if (item === t('chipCompose')) {
    showAll.value = false
    activeTab.value = 'compose'
    return
  }
  if (item === t('chipSelf')) {
    showAll.value = false
    activeTab.value = 'self'
    return
  }
  if (item === t('chipSystem')) {
    showAll.value = false
    activeTab.value = 'system'
    return
  }
  if (item === t('chipAll')) {
    showAll.value = true
    if (activeTab.value === 'compose') activeTab.value = 'self'
    historyKey.value += 1
    void loadBadges()
    return
  }
  historyKey.value += 1
  void loadBadges()
}

const deleteSendboxMail = async (curMailId) => {
  await api.fetch(`/api/sendbox/${curMailId}`, { method: 'DELETE' })
}

const onSent = () => {
  historyKey.value += 1
  void loadBadges()
}

const newestKey = (payload) => String(payload?.results?.[0]?.id ?? '')

const loadBadges = async () => {
  if (!hasAddress.value || badgePending || componentDisposed) return
  badgePending = true
  try {
    const [selfRes, systemRes] = await Promise.all([
      api.fetch(`/api/sendbox?source=${SELF_SOURCES}&limit=1&offset=0`),
      api.fetch(`/api/sendbox?source=${SYSTEM_SOURCES}&limit=1&offset=0`),
    ])
    if (componentDisposed) return
    selfCount.value = Number(selfRes?.count) || 0
    systemCount.value = Number(systemRes?.count) || 0
    selfNewestKey = newestKey(selfRes)
    systemNewestKey = newestKey(systemRes)
  } catch {
    // Keep the last known counts on a transient failure.
  } finally {
    badgePending = false
  }
}

const probeBadges = async () => {
  if (!hasAddress.value || badgePending || componentDisposed) return
  badgePending = true
  try {
    const [selfRes, systemRes] = await Promise.all([
      api.fetch(`/api/sendbox?source=${SELF_SOURCES}&limit=1&offset=0&with_count=0`),
      api.fetch(`/api/sendbox?source=${SYSTEM_SOURCES}&limit=1&offset=0&with_count=0`),
    ])
    if (componentDisposed) return
    const nextSelf = newestKey(selfRes)
    const nextSystem = newestKey(systemRes)
    const changed = nextSelf !== selfNewestKey || nextSystem !== systemNewestKey
    selfNewestKey = nextSelf
    systemNewestKey = nextSystem
    if (changed) {
      badgePending = false
      await loadBadges()
    }
  } catch {
    // Keep the last known counts on a transient failure.
  } finally {
    badgePending = false
  }
}

const startBadgeRefresh = () => {
  if (badgeTimer != null || typeof window === 'undefined' || componentDisposed) return
  badgeTimer = window.setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
    void probeBadges()
  }, BADGE_REFRESH_MS)
}

const stopBadgeRefresh = () => {
  if (badgeTimer == null || typeof window === 'undefined') return
  window.clearInterval(badgeTimer)
  badgeTimer = null
}

const handleVisibilityChange = () => {
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
    void probeBadges()
  }
}

onMounted(async () => {
  try {
    if (!userSettings.value.user_id) await api.getUserSettings()
    await api.getSettings()
    await loadBadges()
  } finally {
    initializing.value = false
  }
  if (componentDisposed) return
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }
  startBadgeRefresh()
})

onBeforeUnmount(() => {
  componentDisposed = true
  stopBadgeRefresh()
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleVisibilityChange)
  }
})
</script>

<template>
  <div class="workspace-page send-workspace space-y-5">
    <div class="workspace-page-header">
      <div>
        <h2 class="text-xl font-bold text-slate-900 dark:text-white tracking-tight">{{ t('title') }}</h2>
        <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{{ t('subtitle') }}</p>
      </div>
      <div class="flex items-center gap-2 flex-wrap justify-end">
        <div
          v-if="settings.address"
          class="workspace-badge"
        >
          {{ t('addressLabel') }}:
          <span>{{ settings.address }}</span>
        </div>
        <div class="workspace-badge workspace-badge--accent">
          <span v-if="isAdmin">{{ t('adminUnlimited') }}</span>
          <span v-else>{{ t('balance', { n: settings.send_balance || 0 }) }}</span>
        </div>
        <StatusIndicator :status="connStatus" :label="connLabel" />
        <n-switch v-model:value="autoRefresh" size="small" :round="false">
          <template #checked>{{ t('autoRefreshOn') }}</template>
          <template #unchecked>{{ t('autoRefreshOff') }}</template>
        </n-switch>
      </div>
    </div>

    <n-tabs :value="activeTab" type="line" @update:value="onTabUpdate">
      <n-tab-pane name="compose"><template #tab>{{ t('tabCompose') }}</template></n-tab-pane>
      <n-tab-pane name="self">
        <template #tab>
          <n-badge :value="selfCount" :max="99" :show="selfCount > 0" :offset="[8, -2]">
            {{ t('tabSelf') }}
          </n-badge>
        </template>
      </n-tab-pane>
      <n-tab-pane name="system">
        <template #tab>
          <n-badge :value="systemCount" :max="99" :show="systemCount > 0" :offset="[8, -2]">
            {{ t('tabSystem') }}
          </n-badge>
        </template>
      </n-tab-pane>
    </n-tabs>

    <PromptChips :suggestions="chips" @select="handleSelectChip" />

    <SendMail
      v-show="activeTab === 'compose' && !showAll"
      @sent="onSent"
      @send-unknown="onSent"
      @send-error="onSent"
    />

    <div
      v-if="showHistory"
      class="settings-section"
    >
      <SendHistoryPane
        endpoint="/api/sendbox"
        :source="historySource"
        :enable-user-delete-email="openSettings.enableUserDeleteEmail"
        :delete-mail="deleteSendboxMail"
        :empty-description="historyEmpty"
        :refresh-key="historyKey"
        :auto-refresh="autoRefresh && showHistory"
      />
    </div>
  </div>
</template>
