<template>
  <div class="unified-inbox workspace-page">
    <div class="workspace-page-header">
      <div><div class="workspace-eyebrow">{{ w('workspace') }}</div><h1>{{ w('inbox') }}</h1><p>{{ w('inboxSubtitle') }}</p></div>
      <div class="workspace-page-header__actions">
        <StatusIndicator v-if="hasAccess" :status="connStatus" :label="connLabel" class="inbox-status" />
        <label v-if="hasAccess" class="inbox-sync"><n-switch v-model:value="autoRefresh" size="small" :aria-label="w('autoRefresh')" /><span>{{ w('autoRefresh') }}</span></label>
        <n-button :loading="loading" :disabled="!hasAccess" @click="refreshList" :aria-label="w('refresh')"><template #icon><MailIcon name="refresh" :size="16" /></template>{{ w('refresh') }}</n-button>
      </div>
    </div>
    <div v-if="!hasAccess" class="inbox-guest">
      <div><div class="workspace-eyebrow">ONE MAIL</div><h2>{{ w('brandTagline') }}</h2><p>{{ t('auth.loginRequired') }}</p></div>
      <div class="inbox-guest__actions"><n-button type="primary" @click="router.push(getRouterPathWithLang('/user', locale))">{{ w('login') }}</n-button><n-button @click="router.push(getRouterPathWithLang('/temp-mail', locale))">{{ w('tempMail') }}</n-button><n-button quaternary @click="activeTab = 'settings'">{{ w('apiSettings') }}</n-button></div>
    </div>
    <n-alert v-else-if="!isLoggedIn && hasKey" type="info" :show-icon="false" class="mb-5">{{ t('auth.apiKeyMode') }} <n-button text @click="activeTab = 'settings'">{{ w('apiSettings') }}</n-button></n-alert>
    <div class="inbox-layout">
      <section class="workspace-panel inbox-main-panel" :aria-label="w('inbox')">
        <n-tabs v-model:value="activeTab" type="line" class="inbox-tabs" animated>
          <n-tab-pane name="list" :tab="w('allMail')">
            <form class="inbox-toolbar" @submit.prevent="applySearch">
              <n-input v-model:value="q" class="inbox-search" :placeholder="w('searchHint')" :input-props="{ 'aria-label': w('searchHint') }" clearable @clear="clearSearch">
                <template #prefix><MailIcon name="search" :size="16" /></template>
              </n-input>
              <n-button attr-type="submit" :disabled="!hasAccess">{{ t('list.search') }}</n-button>
              <n-button :secondary="showFilters" :type="showFilters ? 'primary' : 'default'" :aria-expanded="showFilters" @click="showFilters = !showFilters"><template #icon><MailIcon name="sliders" :size="16" /></template>{{ w('filters') }}</n-button>
            </form>
            <div v-if="showFilters" class="inbox-filters">
              <n-select v-model:value="sourceFilter" :options="sourceOptions" clearable size="small" :placeholder="t('list.allSources')" :aria-label="t('list.allSources')" style="width: 155px" @update:value="applyFilter" />
              <n-select v-model:value="accountFilter" :options="accountOptions" clearable size="small" :placeholder="t('list.allAccounts')" :aria-label="t('list.allAccounts')" style="width: 210px" @update:value="applyFilter" />
              <n-checkbox v-model:checked="unreadOnly" @update:checked="applyFilter">{{ w('unread') }}</n-checkbox>
              <n-checkbox v-model:checked="starOnly" @update:checked="applyFilter">{{ w('starred') }}</n-checkbox>
              <button v-if="filterActive" type="button" class="workspace-link" @click="clearFilters">{{ w('clearFilters') }}</button>
            </div>
            <div class="inbox-column-labels"><span>{{ w(route.query.view === 'starred' ? 'starred' : route.query.view === 'unread' ? 'unread' : 'messages') }}<span v-if="hasAccess && count !== null"> · {{ count }}</span></span><span>{{ w('received') }}</span></div>
            <n-alert v-if="degradedShards.length" type="warning" class="inbox-alert"><span>{{ t('list.incompleteResults') }} ({{ degradedShards.join(', ') }})</span><n-button text size="tiny" :loading="loading" @click="refreshList">{{ t('list.retryDegraded') }}</n-button></n-alert>
            <div v-if="optionsError" class="inbox-alert workspace-caption">{{ optionsError }} <n-button text size="tiny" @click="retryOptions">{{ w('retry') }}</n-button></div>
            <div v-if="loading && !emails.length" class="p-5 space-y-6" :aria-label="t('list.loading')" aria-busy="true"><div v-for="i in 5" :key="i" class="flex gap-4"><n-skeleton circle size="medium" /><div class="flex-1 space-y-3"><n-skeleton text :width="'35%'" /><n-skeleton text :width="'75%'" /><n-skeleton text :width="'50%'" /></div></div></div>
            <WorkspaceEmpty v-else-if="listError && !emails.length" icon="circle-x" :title="w('retry')" :description="listError"><n-button @click="loadList">{{ w('retry') }}</n-button></WorkspaceEmpty>
            <WorkspaceEmpty v-else-if="!hasAccess" icon="lock" :title="w('privateSpace')" :description="w('guestHint')"><n-button type="primary" @click="router.push(getRouterPathWithLang('/user', locale))">{{ w('login') }}</n-button></WorkspaceEmpty>
            <WorkspaceEmpty v-else-if="!emails.length" :icon="filterActive ? 'search' : 'inbox'" :title="w(filterActive ? 'noResults' : 'noMail')" :description="w(filterActive ? 'noResultsDescription' : 'noMailDescription')"><n-button v-if="filterActive" @click="clearFilters">{{ w('clearFilters') }}</n-button><n-button v-else-if="isLoggedIn" @click="router.push(getRouterPathWithLang('/user/external-accounts', locale))">{{ w('manageAccounts') }}</n-button></WorkspaceEmpty>
            <div v-else class="inbox-rows" :aria-busy="loading">
              <InboxMessageRow v-for="row in emails" :key="row.id" :email="row" :code="extractCardCode(row.subject)" :time-label="fmtRowTime(row.received_at)" :full-time="fmtTime(row.received_at)" :busy="pendingRows.has(row.id)" @open="openDetail" @star="toggleRowStar" @read="toggleRowRead" @copy-code="copyQuickCode" />
            </div>
            <div class="inbox-pagination"><span class="workspace-caption">{{ count === null ? t('list.countUnknown') : t('list.total', { count }) }}</span><div v-if="page > 1 || hasMore" class="flex items-center gap-2"><n-button size="small" :aria-label="w('previousPage')" :disabled="loading || page === 1" @click="setPage(page - 1)"><MailIcon name="arrow-left" :size="15" /></n-button><span class="workspace-caption" aria-live="polite">{{ w('pageNumber', { page }) }}</span><n-button size="small" :aria-label="w('nextPage')" :disabled="loading || degradedShards.length > 0 || !hasMore || !nextCursor" @click="setPage(page + 1)"><MailIcon name="arrow-right" :size="15" /></n-button></div><span v-else class="workspace-caption">{{ lastLoaded ? t('status.lastLoaded', { time: fmtRowTime(lastLoaded.getTime()) }) : '' }}</span></div>
          </n-tab-pane>
      <!-- ② 验证码聚合视图 -->
      <n-tab-pane name="codes" :tab="t('tabs.codes')">
        <div class="inbox-tab-content space-y-4">
          <div class="flex flex-wrap items-end gap-3 bg-zinc-50/60 dark:bg-zinc-900/40 p-4 rounded-2xl border border-zinc-200/60 dark:border-zinc-800/60">
            <div class="flex flex-col gap-1">
              <span class="text-xs text-zinc-500">{{ t('codes.addrLabel') }}</span>
              <n-input
                v-model:value="codesAddr"
                size="small"
                :placeholder="t('codes.addrPlaceholder')"
                clearable
                style="width: min(260px, 100%)"
                @keyup.enter="loadCodes"
                @clear="loadCodes"
              />
            </div>
            <div class="flex flex-col gap-1">
              <span class="text-xs text-zinc-500">{{ w('timeRange') }}</span>
              <n-select v-model:value="codesFresh" size="small" :options="freshOptions" style="width: 120px" />
            </div>
            <n-button type="primary" size="small" ghost :loading="codesLoading" @click="loadCodes">
              {{ t('codes.refresh') }}
            </n-button>
          </div>

          <n-alert v-if="codesDegraded.length" type="warning">{{ t('list.incompleteResults') }} ({{ codesDegraded.join(', ') }})</n-alert>
          <div v-if="codesError && !codes.length" class="text-sm text-rose-500 py-12 text-center">
            {{ codesError }}
          </div>
          <n-empty
            v-else-if="!codesLoading && !codes.length"
            :description="t('codes.empty')"
            class="py-16"
          />
          <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            <div
              v-for="(c, i) in codes"
              :key="i"
              class="group relative rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/70 backdrop-blur-xl p-4 sm:p-5 flex items-start justify-between gap-4 shadow-xs hover:shadow-md hover:border-emerald-500/40 transition-all duration-200"
            >
              <div class="min-w-0 space-y-1.5 flex-1">
                <div class="flex items-center gap-2">
                  <span class="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                  <div class="font-mono text-2xl font-extrabold text-emerald-600 dark:text-emerald-400 tracking-wider break-all select-all">
                    {{ c.code }}
                  </div>
                </div>
                <div class="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                  {{ c.subject || t('list.noSubject') }}
                </div>
                <div class="text-xs text-zinc-500 dark:text-zinc-400 truncate flex items-center gap-1.5">
                  <span v-if="c.to_addr">{{ c.from_addr }} → {{ c.to_addr }}</span>
                  <span v-else>{{ c.from_addr }}</span>
                  <span>·</span>
                  <span class="font-mono">{{ fmtTime(c.received_at) }}</span>
                </div>
              </div>
              <button
                type="button"
                @click="copyCode(i, c.code)"
                class="px-3.5 py-2 rounded-xl text-xs font-semibold border transition-all duration-150 cursor-pointer shrink-0 shadow-2xs flex items-center gap-1.5 active:scale-95"
                :class="copiedIndex === i
                  ? 'bg-emerald-500 text-white border-emerald-600 shadow-emerald-500/30'
                  : 'bg-zinc-50 dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 hover:text-emerald-600 dark:hover:text-emerald-400 hover:border-emerald-500/30'"
              >
                <MailIcon :name="copiedIndex === i ? 'check' : 'copy'" :size="15" />
                <span>{{ copiedIndex === i ? t('codes.copied') : t('codes.copy') }}</span>
              </button>
            </div>
          </div>
        </div>
      </n-tab-pane>

      <!-- ③ 聚合器运行状态 -->
      <n-tab-pane name="status" :tab="w('sync')">
        <div class="inbox-tab-content space-y-4">
          <div class="flex items-center justify-between flex-wrap gap-2">
            <p class="text-xs text-zinc-500 dark:text-zinc-400 max-w-2xl">{{ t('status.mode') }}</p>
            <n-button size="small" :loading="statusLoading" @click="loadStatus">
              <template #icon><n-icon><RefreshRound /></n-icon></template>
              {{ t('codes.refresh') }}
            </n-button>
          </div>

          <div class="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
            <div class="rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/70 backdrop-blur-xl p-4 sm:p-5 shadow-xs hover:border-blue-500/30 transition-all">
              <div class="text-xs font-medium text-zinc-500 dark:text-zinc-400 flex items-center gap-2">
                <span class="p-1 rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400"><MailIcon name="mail" :size="16" /></span>
                <span>{{ t('status.emails') }}</span>
              </div>
              <div class="text-2xl sm:text-3xl font-bold text-zinc-900 dark:text-zinc-100 mt-2 font-mono tracking-tight">{{ status.emails }}</div>
            </div>
            <div class="rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/70 backdrop-blur-xl p-4 sm:p-5 shadow-xs hover:border-emerald-500/30 transition-all">
              <div class="text-xs font-medium text-zinc-500 dark:text-zinc-400 flex items-center gap-2">
                <span class="p-1 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"><MailIcon name="inbox" :size="16" /></span>
                <span>{{ t('status.unread') }}</span>
              </div>
              <div class="text-2xl sm:text-3xl font-bold text-emerald-600 dark:text-emerald-400 mt-2 font-mono tracking-tight">{{ status.unread }}</div>
            </div>
            <div class="rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/70 backdrop-blur-xl p-4 sm:p-5 shadow-xs hover:border-purple-500/30 transition-all">
              <div class="text-xs font-medium text-zinc-500 dark:text-zinc-400 flex items-center gap-2">
                <span class="p-1 rounded-lg bg-purple-500/10 text-purple-600 dark:text-purple-400"><MailIcon name="globe" :size="16" /></span>
                <span>{{ t('status.sources') }}</span>
              </div>
              <div class="text-2xl sm:text-3xl font-bold text-zinc-900 dark:text-zinc-100 mt-2 font-mono tracking-tight">{{ status.sources.length }}</div>
            </div>
            <div class="rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/70 backdrop-blur-xl p-4 sm:p-5 shadow-xs hover:border-amber-500/30 transition-all">
              <div class="text-xs font-medium text-zinc-500 dark:text-zinc-400 flex items-center gap-2">
                <span class="p-1 rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400"><MailIcon name="users" :size="16" /></span>
                <span>{{ t('status.accounts') }}</span>
              </div>
              <div class="text-2xl sm:text-3xl font-bold text-zinc-900 dark:text-zinc-100 mt-2 font-mono tracking-tight">{{ status.accounts.length }}</div>
            </div>
          </div>

          <div
            v-if="status.sources.length"
            class="rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white dark:bg-zinc-900/60 p-4 shadow-xs space-y-2"
          >
            <div class="text-xs font-semibold text-zinc-600 dark:text-zinc-300">{{ t('status.sources') }}</div>
            <div class="flex flex-wrap gap-2">
              <n-tag v-for="s in status.sources" :key="s" size="small" :bordered="false">{{ s }}</n-tag>
            </div>
          </div>

          <div v-if="statusError" class="text-sm text-rose-500 py-4">
            {{ statusError }}
          </div>
          <div v-if="lastRefresh" class="text-xs text-zinc-400 font-mono">
            {{ t('status.lastRefresh', { time: fmtTime(lastRefresh.getTime()) }) }}
          </div>
        </div>
      </n-tab-pane>

      <!-- ④ API-key 设置 -->
      <n-tab-pane name="settings" :tab="w('apiSettings')">
        <div class="inbox-tab-content grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div class="rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white dark:bg-zinc-900/60 p-5 space-y-3 shadow-xs">
            <h3 class="text-sm font-semibold text-zinc-800 dark:text-zinc-200 flex items-center gap-2">
              <span><MailIcon name="key" :size="16" /></span>
              <span>{{ t('settings.title') }}</span>
            </h3>
            <p class="text-xs text-zinc-500">{{ t('settings.keyTip') }}</p>
            <n-input
              v-model:value="keyInput"
              type="password"
              show-password-on="click"
              :placeholder="t('settings.keyPlaceholder')"
            />
            <div class="flex gap-2 pt-1">
              <n-button type="primary" size="small" @click="saveKey">{{ t('settings.save') }}</n-button>
              <n-button size="small" :loading="testing" @click="testKey">{{ t('settings.test') }}</n-button>
            </div>
          </div>

          <div class="rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white dark:bg-zinc-900/60 p-5 space-y-3 shadow-xs">
            <h3 class="text-sm font-semibold text-zinc-800 dark:text-zinc-200 flex items-center gap-2">
              <MailIcon name="key" :size="16" />
              <span>{{ t('settings.createKey') }}</span>
            </h3>
            <p class="text-xs text-zinc-500">{{ t('settings.createKeyTip') }}</p>
            <n-input v-model:value="newKeyName" size="small" :placeholder="t('settings.keyNamePlaceholder')" />
            <n-select v-model:value="newKeyRole" size="small" :options="roleOptions" />
            <n-input
              v-model:value="newKeyAdminPassword"
              size="small"
              type="password"
              show-password-on="click"
              :placeholder="t('settings.adminPasswordPlaceholder')"
            />
            <n-button
              type="primary"
              size="small"
              :loading="creating"
              :disabled="!newKeyName.trim() || !newKeyAdminPassword"
              @click="createKey"
            >
              {{ t('settings.create') }}
            </n-button>
            <div
              v-if="newKeyPlain"
              class="rounded-xl bg-zinc-900 dark:bg-zinc-800 text-emerald-400 font-mono text-xs p-3 break-all select-all shadow-inner"
            >
              {{ newKeyPlain }}
            </div>
          </div>
        </div>
      </n-tab-pane>
        </n-tabs>
      </section>
      <aside class="inbox-context">
        <section v-if="hasAccess" class="inbox-context-card">
          <h3><MailIcon name="layers" :size="16" />{{ w('connectedAccounts') }}</h3>
          <div v-for="account in contextAccounts.slice(0, 4)" :key="account.value" class="inbox-account"><span class="inbox-account__icon"><MailIcon name="mail" :size="15" /></span><span class="inbox-account__label" :title="account.label">{{ account.label }}</span></div>
          <p v-if="!contextAccounts.length">{{ w('noAccounts') }}</p>
          <button v-if="isLoggedIn" type="button" class="workspace-link mt-4" @click="router.push(getRouterPathWithLang('/user/external-accounts', locale))">{{ w('manageAccounts') }}<MailIcon name="arrow-right" :size="13" /></button>
        </section>
        <section class="inbox-context-card inbox-context-note">
          <h3><MailIcon name="star" :size="18" />{{ w('calmTitle') }}</h3>
          <p>{{ w('calmDescription') }}</p>
          <button type="button" class="workspace-link" @click="router.push({ path: getRouterPathWithLang('/unified', locale), query: { view: 'starred' } })">{{ w('viewStarred') }}<MailIcon name="arrow-right" :size="13" /></button>
        </section>
        <section class="inbox-context-card">
          <h3>{{ w('keyboardShortcuts') }}</h3>
          <div class="inbox-shortcut"><span>{{ w('shortcutSearch') }}</span><kbd>/</kbd></div>
          <div class="inbox-shortcut"><span>{{ w('shortcutOpen') }}</span><kbd>Enter</kbd></div>
        </section>
      </aside>
    </div>
  </div>
</template>

<script setup>
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { RefreshRound } from '@vicons/material'
import MailIcon from '../components/ui/MailIcon.vue'
import WorkspaceEmpty from '../components/ui/WorkspaceEmpty.vue'
import InboxMessageRow from '../components/inbox/InboxMessageRow.vue'
import { useScopedI18n } from '../i18n/app'
import { api } from '../api'
import { extractSubjectCode as extractCardCode } from '../utils/subject-code'
import { useGlobalState, MIN_AUTO_REFRESH_INTERVAL } from '../store'
import StatusIndicator from '../components/ai/StatusIndicator.vue'
import { useMessage } from 'naive-ui'
import { getRouterPathWithLang } from '../utils'

const { locale, t } = useScopedI18n('unified')
const { t: w } = useScopedI18n('workspace')
const showFilters = ref(false)
const pendingRows = ref(new Set())
const { unifiedApiKey, adminAuth, userJwt, userSettings, configAutoRefreshInterval } = useGlobalState()
const router = useRouter()
const route = useRoute()
const message = useMessage()

const isLoggedIn = computed(() => !!userJwt.value?.trim())
const hasKey = computed(() => !!unifiedApiKey.value?.trim())
const hasAdmin = computed(() => !!adminAuth.value?.trim())
const hasAccess = computed(() => isLoggedIn.value || hasKey.value || hasAdmin.value)

// ---- 顶部连接状态徽标 ----
const connected = ref(false)
const connStatus = computed(() => {
  if (!hasAccess.value) return 'offline'
  if (connected.value) return 'online'
  if (listError.value || codesError.value || statusError.value || degradedShards.value.length || codesDegraded.value.length) return 'error'
  return 'connecting'
})
const connLabel = computed(() => {
  if (!hasAccess.value) return t('status.offline')
  if (connected.value) return t('status.online')
  if (listError.value || codesError.value || statusError.value || degradedShards.value.length || codesDegraded.value.length) return t('settings.testFail')
  return t('status.connecting')
})

const validTabs = ['list', 'codes', 'status', 'settings']
const activeTab = ref(validTabs.includes(route.query.tab) ? route.query.tab : 'list')

// ---- 邮件列表 ----
const PAGE_SIZE = 20
// 刷新频率上限：跟随全局设置，但不允许高于 MIN_AUTO_REFRESH_INTERVAL 的频率。
// 历史版本曾硬编码 5s 轮询，每次都附带 COUNT(*) 全表扫描，会烧穿 D1 rows_read 免费额度。
const refreshIntervalMs = computed(() => (
  Math.max(MIN_AUTO_REFRESH_INTERVAL, Number(configAutoRefreshInterval.value) || MIN_AUTO_REFRESH_INTERVAL) * 1000
))
/** @type {import('vue').Ref<import('../api/contracts').UnifiedEmailSummary[]>} */
const emails = ref([])
/** @type {import('vue').Ref<number | null>} */
const count = ref(0)
const loading = ref(false)
const listError = ref('')
const degradedShards = ref([])
const page = ref(1)
const hasMore = ref(false)
const nextCursor = ref(null)
/** Only visited boundaries are retained; lookup is O(1), storage O(pages visited). */
const pageCursors = new Map([[1, undefined]])
const resetPagination = () => {
  page.value = 1
  pageCursors.clear()
  pageCursors.set(1, undefined)
  nextCursor.value = null
  hasMore.value = false
}
const q = ref(typeof route.query.q === 'string' ? route.query.q : '')
const sourceFilter = ref(typeof route.query.source === 'string' ? route.query.source : null)
const accountFilter = ref(typeof route.query.account === 'string' ? route.query.account : null)
const unreadOnly = ref(route.query.view === 'unread' || route.query.unread === '1')
const starOnly = ref(route.query.view === 'starred' || route.query.starred === '1')

// Only committed route state can drive network reads; input fields are drafts.
const filterParams = computed(() => {
  const query = route.query
  const account = typeof query.account === 'string' ? query.account : ''
  return {
    source: typeof query.source === 'string' ? query.source : undefined,
    unread: query.view === 'unread' || query.unread === '1' ? 1 : undefined,
    starred: query.view === 'starred' || query.starred === '1' ? 1 : undefined,
    q: typeof query.q === 'string' ? query.q.trim() || undefined : undefined,
    to_addr: account.includes('@') ? account : undefined,
    account_id: account && !account.includes('@') ? account : undefined,
  }
})
const listParams = computed(() => ({
  ...filterParams.value,
  limit: PAGE_SIZE,
  cursor: pageCursors.get(page.value),
  with_count: page.value === 1 ? 1 : 0,
}))
const filterActive = computed(() => !!(
  filterParams.value.source ||
  filterParams.value.account_id ||
  filterParams.value.to_addr ||
  filterParams.value.unread ||
  filterParams.value.starred ||
  filterParams.value.q
))

/** @type {Partial<Record<'list' | 'probe' | 'codes' | 'status' | 'options' | 'key' | 'test', AbortController>>} */
const requests = {}
/** @param {keyof typeof requests} kind */
const cancelRequest = (kind) => {
  requests[kind]?.abort()
  delete requests[kind]
}
/** @param {keyof typeof requests} kind */
const beginRequest = (kind) => {
  cancelRequest(kind)
  const controller = new AbortController()
  requests[kind] = controller
  return controller
}
/** @param {keyof typeof requests} kind @param {AbortController} controller */
const currentRequest = (kind, controller) => !componentDisposed && componentActive && requests[kind] === controller && !controller.signal.aborted
const rowRequests = new Map()
const cancelRequests = () => {
  for (const controller of rowRequests.values()) controller.abort()
  rowRequests.clear()
  pendingRows.value.clear()
  loading.value = false
  codesLoading.value = false
  statusLoading.value = false
  creating.value = false
  testing.value = false
  Object.keys(requests).forEach(cancelRequest)
  backgroundListPending = false
  backgroundCodesPending = false
}
let backgroundListPending = false
let backgroundCodesPending = false

// 增量探测基线：最新一封邮件的 (received_at, id) 指纹。轮询先做 1 行探测，
// 基线没变化就完全不拉列表、不跑 COUNT(*)，避免无谓的 D1 rows_read。
const emailSortKey = (row) => `${Number(row?.received_at) || 0}:${row?.id ?? ''}`
let newestSeenKey = ''
let displayedListKey = ''
let autoRefreshTimer = null
let componentDisposed = false
const autoRefresh = ref(true)

const loadList = async ({ background = false } = {}) => {
  if (componentDisposed || !componentActive || !hasAccess.value) return false
  if (background && backgroundListPending) return false
  const controller = beginRequest('list')
  const requestedPage = page.value
  const listParamsSnapshot = listParams.value
  const requestedKey = JSON.stringify(listParamsSnapshot)
  // 后台轮询不请求总数：COUNT(*) 走不了索引、要整表读，是 2026-10-08 打爆 D1
  // 免费档 rows_read 的主因之一。前台刷新（挂载、手动、换筛选、翻页）才重算，
  // 两次之间页面沿用上一次已知的总数。
  const requestedParams = background ? { ...listParamsSnapshot, with_count: 0 } : listParamsSnapshot

  backgroundListPending = background
  loading.value = !background
  if (!background) listError.value = ''

  try {
    const listRes = await api.unified.listEmails(requestedParams, { signal: controller.signal })
    if (!currentRequest('list', controller)) return false
    const incomplete = Boolean(listRes.incomplete || listRes.degraded?.length)
    const received = listRes.results || []
    if (incomplete && displayedListKey === requestedKey) {
      const unavailable = new Set(listRes.unavailable_mailbox_ids || [])
      const byId = new Map(emails.value.filter(row => unavailable.has(row.account_id)).map(row => [row.id, row]))
      for (const row of received) byId.set(row.id, row)
      emails.value = Array.from(byId.values()).sort((a, b) => {
        const timeOrder = Number(b.received_at) - Number(a.received_at)
        if (timeOrder || a.id === b.id) return timeOrder
        return a.id < b.id ? 1 : -1
      }).slice(0, PAGE_SIZE)
    } else emails.value = received
    displayedListKey = requestedKey
    // Refreshing a boundary invalidates every later cursor derived from it.
    for (const boundary of pageCursors.keys()) {
      if (boundary > requestedPage) pageCursors.delete(boundary)
    }
    hasMore.value = Boolean(listRes.has_more)
    nextCursor.value = incomplete ? null : listRes.next_cursor || null
    if (nextCursor.value) pageCursors.set(requestedPage + 1, nextCursor.value)
    // The first page already includes the scoped count; avoid a second full-table scan.
    if (requestedPage === 1 && typeof listRes.count === 'number') {
      count.value = listRes.count
    }
    // 刷新探测基线（仅第一页代表全域最新一封）
    if (requestedPage === 1 && !incomplete) {
      newestSeenKey = emails.value.length ? emailSortKey(emails.value[0]) : ''
    }
    degradedShards.value = Array.isArray(listRes.degraded) ? listRes.degraded : []
    listError.value = ''
    if (incomplete) count.value = null
    connected.value = !incomplete
    lastLoaded.value = new Date()
    return !incomplete
  } catch (e) {
    if (!currentRequest('list', controller)) return false
    connected.value = false
    listError.value = e.message || 'error'
    if (!background) {
      degradedShards.value = []
      emails.value = []
      nextCursor.value = null
      count.value = null
    }
    return false
  } finally {
    if (currentRequest('list', controller)) {
      backgroundListPending = false
      loading.value = false
      delete requests.list
    }
  }
}

const refreshList = () => loadList()
const applySearch = () => {
  const both = unreadOnly.value && starOnly.value
  const query = {
    ...route.query,
    q: q.value.trim() || undefined,
    source: sourceFilter.value || undefined,
    account: accountFilter.value || undefined,
    view: both ? undefined : starOnly.value ? 'starred' : unreadOnly.value ? 'unread' : undefined,
    unread: both ? '1' : undefined,
    starred: both ? '1' : undefined,
  }
  const unchanged = ['q', 'source', 'account', 'view', 'unread', 'starred'].every(key => (query[key] || '') === (route.query[key] || ''))
  if (unchanged) { resetPagination(); loadList(); return }
  router.replace({ query })
}
const applyFilter = applySearch
const clearSearch = () => { q.value = ''; applySearch() }
const clearFilters = () => {
  q.value = ''
  sourceFilter.value = null
  accountFilter.value = null
  unreadOnly.value = false
  starOnly.value = false
  applySearch()
}
const setPage = (target) => {
  if (loading.value || !pageCursors.has(target)) return
  if (target > page.value && (degradedShards.value.length || !hasMore.value)) return
  cancelRequest('probe')
  page.value = target
  loadList()
}
const openDetail = (id) => router.push({
  path: getRouterPathWithLang(`/unified/${encodeURIComponent(id)}`, locale.value || locale),
  query: { from: route.fullPath },
})

const copyQuickCode = async (code) => {
  try {
    await navigator.clipboard.writeText(code)
    message.success(`验证码 ${code} 已复制`)
  } catch (e) {
    message.error(t('codes.copyFailed'))
  }
}

// Mutations share the view lifetime; an old response must never update a new scope.
/** @param {import('../api/contracts').UnifiedEmailSummary} row @param {'is_read' | 'is_starred'} field */
const updateRow = async (row, field) => {
  if (componentDisposed || pendingRows.value.has(row.id)) return
  const controller = new AbortController()
  rowRequests.set(row.id, controller)
  pendingRows.value.add(row.id)
  const rows = emails.value
  const identity = authIdentity.value
  const filters = filterParams.value
  const ownsScope = () => !componentDisposed && !controller.signal.aborted && identity === authIdentity.value && filters === filterParams.value
  // Partial refresh can retain this exact row in a new array. Its optimistic
  // state still belongs to this request and must roll back on provider failure.
  const current = () => ownsScope() && emails.value.includes(row)
  const previous = row[field]
  const target = previous ? 0 : 1
  row[field] = target
  try {
    const options = { signal: controller.signal }
    let result
    if (field === 'is_starred') result = await api.unified.toggleStar(row.id, target, options)
    else if (target) result = await api.unified.markRead(row.id, options)
    else result = await api.unified.markUnread(row.id, options)
    if (!ownsScope()) return
    if (current()) row[field] = result[field] ?? target
    if (field === 'is_starred') message.success(w(row[field] ? 'protected' : 'removeStar'))
    const affectsFilter = field === 'is_starred' ? filters.starred : filters.unread
    if (affectsFilter || rows !== emails.value) {
      const finalValue = result[field] ?? target
      if (affectsFilter && (field === 'is_starred' ? !finalValue : finalValue)) {
        emails.value = emails.value.filter(candidate => candidate.id !== row.id)
      }
      cancelRequest('probe')
      resetPagination()
      count.value = null
      await loadList()
    }
  } catch (error) {
    if (!current()) return
    row[field] = previous
    message.error(error.message || t('settings.testFail'))
  } finally {
    if (rowRequests.get(row.id) === controller) {
      rowRequests.delete(row.id)
      pendingRows.value.delete(row.id)
    }
  }
}
const toggleRowStar = row => updateRow(row, 'is_starred')
const toggleRowRead = row => updateRow(row, 'is_read')

const probeNewestKey = async (signal) => {
  // One row, no COUNT(*); the request shares the view's cancellation scope.
  const probeRes = await api.unified.listEmails({ ...filterParams.value, limit: 1, with_count: 0 }, { signal })
  if (probeRes.degraded?.length) throw new Error(t('list.incompleteResults'))
  const top = (probeRes.results || [])[0]
  return top ? emailSortKey(top) : ''
}

const autoRefreshList = () => {
  if (componentDisposed || !componentActive || !autoRefresh.value || !hasAccess.value) return
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
  if (activeTab.value !== 'list') {
    if (activeTab.value === 'codes' && !codesLoading.value && !backgroundCodesPending) {
      void loadCodes({ background: true })
    }
    return
  }
  if (loading.value || backgroundListPending || requests.probe) return
  const controller = beginRequest('probe')
  void (async () => {
    try {
      const newestKey = await probeNewestKey(controller.signal)
      if (!currentRequest('probe', controller)) return
      const hasNew = newestKey !== newestSeenKey || degradedShards.value.length > 0 || Boolean(listError.value)
      if (hasNew && !backgroundListPending) {
        const loaded = await loadList({ background: true })
        if (loaded && currentRequest('probe', controller)) newestSeenKey = newestKey
      }
    } catch (error) {
      if (currentRequest('probe', controller)) {
        connected.value = false
        // A visible status carries quiet failures without repeated toast messages.
        listError.value = error.message || t('settings.testFail')
      }
    } finally {
      if (requests.probe === controller) delete requests.probe
    }
  })()
}

const startAutoRefresh = () => {
  if (componentDisposed || !componentActive) return
  if (autoRefreshTimer != null || typeof window === 'undefined') return
  autoRefreshTimer = window.setInterval(autoRefreshList, refreshIntervalMs.value)
}

const stopAutoRefresh = () => {
  if (autoRefreshTimer == null || typeof window === 'undefined') return
  window.clearInterval(autoRefreshTimer)
  autoRefreshTimer = null
}

const handleVisibilityChange = () => {
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
    autoRefreshList()
  }
}

// 来源/账号筛选项
const SOURCE_MAP = {
  imap_qq: 'QQ 邮箱',
  imap_gmail: 'Gmail',
  imap_163: '网易 163',
  imap_outlook: 'Outlook',
  cloudflare: 'Cloudflare',
  cf_routing: 'CF 邮件路由',
}

const userAccounts = ref([])
const boundAddresses = ref([])
const optionRows = ref([])

const sourceOptions = computed(() => {
  const set = new Set()
  userAccounts.value.forEach(a => { if (a.source) set.add(a.source) })
  optionRows.value.forEach(r => { if (r.source) set.add(r.source) })
  return [...set].map(s => ({
    label: SOURCE_MAP[s] ? `${SOURCE_MAP[s]} (${s})` : s,
    value: s,
  }))
})

const accountOptions = computed(() => {
  const list = []
  const seenValues = new Set()

  // 1. 用户配置的外部邮箱（最优先，显示 label + username）
  userAccounts.value.forEach(a => {
    const val = a.id
    if (val && !seenValues.has(val)) {
      seenValues.add(val)
      const label = a.label ? `${a.label} (${a.username})` : a.username
      list.push({ label, value: val })
    }
  })

  // 2. 绑定的本站域名邮箱
  boundAddresses.value.forEach(b => {
    const name = typeof b === 'string' ? b : b?.name
    if (name && !seenValues.has(name)) {
      seenValues.add(name)
      list.push({ label: `域名: ${name}`, value: name })
    }
  })

  // 3. 从邮件样本中发现的 account_id / to_addr（兜底兼容）
  optionRows.value.forEach(r => {
    const val = r.to_addr || r.account_id
    if (val && !seenValues.has(val)) {
      seenValues.add(val)
      list.push({ label: val, value: val })
    }
  })

  return list
})

const contextAccounts = computed(() => {
  const accounts = new Map()
  userAccounts.value.forEach(account => accounts.set(account.username || account.id, { value: account.username || account.id, label: account.label || account.username || account.id }))
  boundAddresses.value.forEach(address => {
    const value = typeof address === 'string' ? address : address.name
    if (value && !accounts.has(value)) accounts.set(value, { value, label: value })
  })
  return accounts.size ? [...accounts.values()] : accountOptions.value
})

const optionsError = ref('')
let optionsScope = ''
let optionsPromise = null
let optionsPromiseIdentity = ''
let optionsGeneration = 0

const authIdentity = computed(() => {
  const jwt = userJwt.value?.trim()
  const admin = adminAuth.value?.trim()
  if (jwt) return `user:${jwt}|admin:${admin || ''}`
  if (admin) return `admin:${admin}`
  const key = unifiedApiKey.value?.trim()
  return key ? `key:${key}` : ''
})

const resetOptions = () => {
  optionsGeneration += 1
  optionsScope = ''
  optionsError.value = ''
  userAccounts.value = []
  boundAddresses.value = []
  optionRows.value = []
}

const loadOptions = async () => {
  const identity = authIdentity.value
  if (componentDisposed || !componentActive) return
  if (!identity) {
    resetOptions()
    return
  }
  if (optionsScope === identity && !optionsError.value) return
  if (optionsPromise && optionsPromiseIdentity === identity) return optionsPromise
  const generation = ++optionsGeneration
  const controller = beginRequest('options')
  const requestOptions = { signal: controller.signal }
  optionsError.value = ''
  const promise = (async () => {
    const current = () => currentRequest('options', controller) && generation === optionsGeneration && identity === authIdentity.value
    const tasks = []
    if (isLoggedIn.value) {
      tasks.push(api.userMailAccounts.list(requestOptions).then(res => {
        if (current()) userAccounts.value = res.results || []
      }))
      tasks.push(api.fetch('/user_api/bind_address', requestOptions).then(res => {
        if (current()) boundAddresses.value = res.results || []
      }))
    }
    tasks.push(api.unified.meta(requestOptions).then(res => {
      if (!current()) return
      const rows = []
      ;(res.sources || []).forEach(source => rows.push({ source }))
      ;(res.accounts || []).forEach(account_id => rows.push({ account_id }))
      ;(res.to_addrs || []).forEach(to_addr => rows.push({ to_addr }))
      optionRows.value = rows
      if (res.degraded?.length) throw new Error(`${t('list.incompleteResults')} (${res.degraded.join(', ')})`)
    }))
    const results = await Promise.allSettled(tasks)
    if (!current()) return
    if (results.some(result => result.status === 'rejected')) {
      throw new AggregateError(results.filter(result => result.status === 'rejected').map(result => result.reason), '筛选项加载失败，请重试')
    }
    optionsScope = identity
  })()
  const handledPromise = promise.catch(error => {
    if (currentRequest('options', controller) && generation === optionsGeneration && identity === authIdentity.value) {
      optionsScope = ''
      optionsError.value = error.message || '筛选项加载失败，请重试'
    }
    return null
  })
  optionsPromise = handledPromise
  optionsPromiseIdentity = identity
  handledPromise.finally(() => {
    if (requests.options === controller) delete requests.options
    if (optionsPromise === handledPromise) {
      optionsPromise = null
      optionsPromiseIdentity = ''
    }
  })
  return handledPromise
}

const retryOptions = () => {
  optionsError.value = ''
  optionsScope = ''
  return loadOptions()
}

// ---- 验证码视图 ----
const codesAddr = ref('')
const codesFresh = ref(10)
const codes = ref([])
const codesLoading = ref(false)
const codesError = ref('')
const codesDegraded = ref([])
const copiedIndex = ref(-1)
const freshOptions = [
  { label: '10 min', value: 10 },
  { label: '1 h', value: 60 },
  { label: '24 h', value: 1440 },
]

const loadCodes = async ({ background = false } = {}) => {
  if (background && backgroundCodesPending) return
  if (componentDisposed || !componentActive || !hasAccess.value) return
  const controller = beginRequest('codes')
  const identity = authIdentity.value
  const isCurrent = () =>
    currentRequest('codes', controller) && identity === authIdentity.value && hasAccess.value
  if (!identity) {
    if (!background) codesLoading.value = false
    return
  }
  if (background) {
    backgroundCodesPending = true
  } else {
    codesLoading.value = true
    codesError.value = ''
  }
  try {
    const res = await api.unified.verifcodes(codesAddr.value.trim(), codesFresh.value * 60 * 1000, undefined, { signal: controller.signal })
    if (!isCurrent()) return
    codes.value = res.results || []
    codesDegraded.value = res.degraded || []
    connected.value = codesDegraded.value.length === 0
    codesError.value = ''
    lastLoaded.value = new Date()
  } catch (e) {
    if (!isCurrent()) return
    connected.value = false
    if (!background) {
      codesError.value = e.message || 'error'
      codes.value = []
    }
  } finally {
    if (isCurrent()) {
      backgroundCodesPending = false
      codesLoading.value = false
      delete requests.codes
    }
  }
}

let codeCopyTimer
const copyCode = async (index, code) => {
  try {
    await navigator.clipboard.writeText(code)
    if (componentDisposed) return
    copiedIndex.value = index
    clearTimeout(codeCopyTimer)
    codeCopyTimer = setTimeout(() => { copiedIndex.value = -1 }, 1500)
  } catch (e) {
    message.error(t('codes.copyFailed'))
  }
}

// ---- 聚合器状态 ----
const status = ref({ emails: 0, unread: 0, sources: [], accounts: [] })
const statusLoading = ref(false)
const statusError = ref('')
const lastRefresh = ref(null)
// This records the last successful read from the unified API, not the last scheduled sync time.
const lastLoaded = ref(null)

const loadStatus = async () => {
  if (componentDisposed || !componentActive || !hasAccess.value) return
  const controller = beginRequest('status')
  const identity = authIdentity.value
  const isCurrent = () =>
    currentRequest('status', controller) && identity === authIdentity.value && hasAccess.value
  if (!identity) {
    statusLoading.value = false
    return
  }
  statusLoading.value = true
  statusError.value = ''
  try {
    const stats = await api.unified.stats({}, { signal: controller.signal })
    if (!isCurrent()) return
    if (!accountOptions.value.length && !sourceOptions.value.length) {
      await loadOptions()
      if (!isCurrent()) return
    }
    status.value = {
      emails: stats.count || 0,
      unread: stats.unread || 0,
      sources: sourceOptions.value.map(s => s.value),
      accounts: accountOptions.value.map(a => a.label || a.value),
    }
    lastRefresh.value = new Date()
    lastLoaded.value = lastRefresh.value
    statusError.value = stats.degraded?.length ? `${t('list.incompleteResults')} (${stats.degraded.join(', ')})` : ''
    connected.value = !stats.degraded?.length
  } catch (e) {
    if (!isCurrent()) return
    statusError.value = e.message || 'error'
    connected.value = false
  } finally {
    if (isCurrent()) { statusLoading.value = false; delete requests.status }
  }
}

// ---- API-key 设置 ----
const keyInput = ref(unifiedApiKey.value || '')
const testing = ref(false)
const newKeyName = ref('')
const newKeyRole = ref('readonly')
const newKeyAdminPassword = ref('')
const creating = ref(false)
const newKeyPlain = ref('')
const roleOptions = computed(() => [
  { label: t('settings.readonly'), value: 'readonly' },
  { label: t('settings.adminRole'), value: 'admin' },
])

const saveKey = () => {
  const v = keyInput.value.trim()
  if (!v) { message.error(t('settings.required')); return }
  unifiedApiKey.value = v
  message.success(t('settings.saved'))
}

const testKey = async () => {
  if (testing.value) return
  if (!unifiedApiKey.value.trim()) {
    message.error(t('settings.required'))
    return
  }
  const controller = beginRequest('test')
  testing.value = true
  try {
    await api.unified.count({}, { signal: controller.signal })
    if (!currentRequest('test', controller)) return
    connected.value = true
    message.success(t('settings.testOk'))
  } catch (e) {
    if (!currentRequest('test', controller)) return
    connected.value = false
    message.error(`${t('settings.testFail')}: ${e.message}`)
  } finally {
    if (requests.test === controller) { testing.value = false; delete requests.test }
  }
}

const createKey = async () => {
  if (creating.value || !newKeyName.value.trim() || !newKeyAdminPassword.value) return
  const controller = beginRequest('key')
  creating.value = true
  try {
    const res = await api.admin.createUnifiedKey({
      name: newKeyName.value.trim(),
      role: newKeyRole.value,
    }, newKeyAdminPassword.value, { signal: controller.signal })
    if (!currentRequest('key', controller)) return
    newKeyPlain.value = res.key
    unifiedApiKey.value = res.key
    keyInput.value = res.key
    connected.value = true
    message.success(t('settings.created'))
  } catch (e) {
    if (!currentRequest('key', controller)) return
    message.error(e.message || 'error')
  } finally {
    if (requests.key === controller) { creating.value = false; delete requests.key }
  }
}

// ---- 通用 ----
const fmtTime = (ms) => {
  if (!ms) return ''
  const d = new Date(Number(ms))
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
}

const refreshCurrent = () => {
  if (activeTab.value === 'list') loadList()
  else if (activeTab.value === 'codes') loadCodes()
  else if (activeTab.value === 'status') loadStatus()
}

watch(authIdentity, (identity, previousIdentity) => {
  if (identity === previousIdentity) return
  cancelRequests()
  newestSeenKey = ''
  resetOptions()
  connected.value = false
  loading.value = false
  listError.value = ''
  codesAddr.value = ''
  codes.value = []
  codesError.value = ''
  codesDegraded.value = []
  codesLoading.value = false
  status.value = { emails: 0, unread: 0, sources: [], accounts: [] }
  statusError.value = ''
  statusLoading.value = false
  emails.value = []
  count.value = 0
  resetPagination()
  degradedShards.value = []
  lastLoaded.value = null
  lastRefresh.value = null
  pendingRows.value.clear()
  if (!identity) return
  void loadOptions()
  refreshCurrent()
})

watch(autoRefresh, (enabled) => {
  if (enabled) {
    startAutoRefresh()
  } else {
    stopAutoRefresh()
  }
})

// 设置里调整刷新间隔后，重排已挂载的定时器
watch(refreshIntervalMs, () => {
  if (autoRefreshTimer != null) {
    stopAutoRefresh()
    startAutoRefresh()
  }
})

watch(codesFresh, () => {
  if (activeTab.value === 'codes') {
    loadCodes()
  }
})

watch(activeTab, (tab) => {
  if ((route.query.tab || 'list') !== tab) router.replace({ query: { ...route.query, tab: tab === 'list' ? undefined : tab } })
  if (tab === 'codes') {
    loadCodes()
  } else if (tab === 'status') {
    loadStatus()
  }
})

// Sidebar and global search share the same bookmarkable inbox state.
watch(() => [route.query.q, route.query.view, route.query.source, route.query.account, route.query.unread, route.query.starred, route.query.tab], (current, previous) => {
  const [search, view, source, account, unread, starred, tab] = current
  activeTab.value = validTabs.includes(tab) ? tab : 'list'
  if (current.slice(0, 6).some((value, index) => value !== previous[index])) {
    cancelRequest('probe')
    newestSeenKey = ''
    q.value = typeof search === 'string' ? search : ''
    sourceFilter.value = typeof source === 'string' ? source : null
    accountFilter.value = typeof account === 'string' ? account : null
    unreadOnly.value = view === 'unread' || unread === '1'
    starOnly.value = view === 'starred' || starred === '1'
    resetPagination()
    loadList()
  }
})
const fmtRowTime = (ms) => {
  const date = new Date(Number(ms))
  if (!ms || Number.isNaN(date.getTime())) return ''
  const today = date.toDateString() === new Date().toDateString()
  return new Intl.DateTimeFormat(locale.value, today ? { hour: '2-digit', minute: '2-digit', hour12: false } : { month: 'short', day: 'numeric' }).format(date)
}

let componentActive = true

onMounted(async () => {
  componentDisposed = false
  if (userJwt.value && !userSettings.value.user_id) {
    await api.getUserSettings(message)
  }
  if (hasAccess.value) {
    await loadOptions()
    if (componentDisposed || !componentActive) return
    await loadList()
    if (activeTab.value === 'codes') await loadCodes()
    else if (activeTab.value === 'status') await loadStatus()
  }
  if (componentDisposed || !componentActive) return
  if (autoRefresh.value) {
    startAutoRefresh()
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }
})

onActivated(() => {
  const wasInactive = !componentActive
  componentActive = true
  if (componentDisposed || !wasInactive) return
  void loadOptions()
  refreshCurrent()
  if (autoRefresh.value) startAutoRefresh()
})

onDeactivated(() => {
  componentActive = false
  cancelRequests()
  stopAutoRefresh()
})

onBeforeUnmount(() => {
  clearTimeout(codeCopyTimer)
  componentDisposed = true
  backgroundListPending = false
  backgroundCodesPending = false
  cancelRequests()
  stopAutoRefresh()
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleVisibilityChange)
  }
})
</script>
