<template>
  <div class="unified-inbox max-w-6xl mx-auto px-4 py-6 text-left space-y-4">
    <!-- 页头 -->
    <div class="flex items-center justify-between flex-wrap gap-3 pb-3 border-b border-zinc-200/80 dark:border-zinc-800/80">
      <div>
        <h1 class="text-xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
          <span>📥</span>
          <span>{{ t('title') }}</span>
        </h1>
        <p class="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{{ t('subtitle') }}</p>
      </div>
      <div class="flex items-center gap-3">
        <div class="flex flex-col items-end gap-0.5">
          <StatusIndicator :status="connStatus" :label="connLabel" />
          <span v-if="lastLoaded" class="text-[10px] text-zinc-400">{{ t('status.lastLoaded', { time: fmtTime(lastLoaded.getTime()) }) }}</span>
        </div>
        <n-button size="small" :loading="loading" @click="refreshList" quaternary circle>
          <template #icon><n-icon><RefreshRound /></n-icon></template>
        </n-button>
      </div>
    </div>

    <!-- 登录用户走用户 JWT；游客可使用兼容的 API-key 通道 -->
    <div
      v-if="!hasAccess"
      class="rounded-2xl border border-amber-200 dark:border-amber-800/60 bg-amber-50/80 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 px-5 py-3.5 text-sm shadow-xs flex items-center justify-between gap-3"
    >
      <div class="flex items-center gap-2">
        <span>⚠️</span>
        <span>{{ t('auth.loginRequired') }}</span>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <n-button size="small" type="primary" @click="router.push('/user')">
          {{ t('auth.login') }}
        </n-button>
        <n-button size="small" ghost @click="activeTab = 'settings'">
          {{ t('tabs.settings') }}
        </n-button>
      </div>
    </div>
    <div
      v-else-if="!isLoggedIn && hasKey"
      class="rounded-2xl border border-sky-200 dark:border-sky-800/60 bg-sky-50/80 dark:bg-sky-950/30 text-sky-800 dark:text-sky-300 px-5 py-2.5 text-xs flex items-center justify-between gap-3 shadow-xs"
    >
      <div class="flex items-center gap-2">
        <span>🔑</span>
        <span>{{ t('auth.apiKeyMode') }}</span>
      </div>
      <n-button size="tiny" ghost @click="activeTab = 'settings'">管理 Key</n-button>
    </div>

    <n-tabs v-model:value="activeTab" type="segment" class="unified-tabs">
      <!-- ① 邮件列表 -->
      <n-tab-pane name="list" :tab="t('tabs.list')">
        <div class="space-y-4 pt-2">
          <!-- 快捷筛选 PromptChips -->
          <PromptChips :suggestions="quickFilterChips" @select="handleSelectChip" />

          <!-- 过滤 / 搜索 / 分页控制 -->
          <div class="flex flex-wrap items-center gap-2 bg-zinc-50/60 dark:bg-zinc-900/40 p-3 rounded-2xl border border-zinc-200/60 dark:border-zinc-800/60">
            <n-input
              v-model:value="q"
              :placeholder="t('list.searchPlaceholder')"
              clearable
              size="small"
              style="max-width: 260px"
              @keyup.enter="applySearch"
            />
            <n-button size="small" type="primary" ghost @click="applySearch">
              <template #icon><n-icon><SearchRound /></n-icon></template>
              {{ t('list.search') }}
            </n-button>
            <n-select
              v-model:value="sourceFilter"
              :options="sourceOptions"
              clearable
              size="small"
              :placeholder="t('list.allSources')"
              style="width: 140px"
              @update:value="applyFilter"
            />
            <n-select
              v-model:value="accountFilter"
              :options="accountOptions"
              clearable
              size="small"
              :placeholder="t('list.allAccounts')"
              style="min-width: 180px; max-width: 260px"
              @update:value="applyFilter"
            />
            <n-checkbox v-model:checked="unreadOnly" @update:checked="applyFilter">
              {{ t('list.unread') }}
            </n-checkbox>
            <n-checkbox v-model:checked="starOnly" @update:checked="applyFilter">
              ⭐ 仅星标
            </n-checkbox>
            <div class="flex-1"></div>
            <span class="text-xs text-zinc-400 font-mono">{{ t('list.total', { count }) }}</span>
          </div>
          <div v-if="optionsError" class="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-2">
            <span>{{ optionsError }}</span>
            <n-button text size="tiny" @click="retryOptions">重试</n-button>
          </div>

          <div v-if="loading" class="py-20 text-center text-zinc-400 flex flex-col items-center gap-2">
            <span class="animate-spin text-xl">⏳</span>
            <span>{{ t('list.loading') }}</span>
          </div>
          <div v-else-if="listError" class="py-16 text-center text-sm text-rose-500">
            <div>{{ listError }}</div>
            <n-button size="small" class="mt-3" @click="loadList">重试</n-button>
          </div>
          <n-empty
            v-else-if="!emails.length"
            :description="filterActive ? t('list.emptyFiltered') : t('list.empty')"
            class="py-20"
          />
          <div
            v-else
            class="rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 divide-y divide-zinc-100 dark:divide-zinc-800/70 overflow-hidden bg-white dark:bg-zinc-900/60 shadow-xs"
          >
            <button
              v-for="row in emails"
              :key="row.id"
              class="w-full text-left px-5 py-3.5 flex items-center gap-4 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors cursor-pointer"
              @click="openDetail(row.id)"
            >
              <span
                class="w-2.5 h-2.5 rounded-full shrink-0 transition-all"
                :class="row.is_read ? 'bg-transparent border border-zinc-300 dark:border-zinc-700' : 'bg-emerald-500 shadow-xs shadow-emerald-500/50'"
              ></span>
              <span
                v-if="row.is_starred"
                class="text-amber-400 text-sm shrink-0"
                title="已星标（受保护，不会被自动清理正文）"
              >⭐</span>
              <div class="min-w-0 flex-1 space-y-1">
                <div class="flex items-baseline gap-2 flex-wrap">
                  <span class="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                    {{ row.subject || t('list.noSubject') }}
                  </span>
                  <n-tag size="tiny" :bordered="false" type="info" class="shrink-0 font-mono">{{ row.source }}</n-tag>
                  <n-tag v-if="row.account_id" size="tiny" :bordered="false" class="shrink-0 font-mono">{{ row.account_id }}</n-tag>
                </div>
                <div class="text-xs text-zinc-500 dark:text-zinc-400 truncate flex items-center gap-2">
                  <span>{{ row.from_addr }}</span>
                  <span v-if="row.account_id" class="text-zinc-400">→ {{ row.account_id }}</span>
                </div>
              </div>
              <div class="text-xs text-zinc-400 shrink-0 font-mono">{{ fmtTime(row.received_at) }}</div>
            </button>
          </div>

          <n-pagination
            v-if="count > PAGE_SIZE"
            :page="page"
            :page-count="Math.ceil(count / PAGE_SIZE)"
            :page-size="PAGE_SIZE"
            @update:page="setPage"
            class="justify-center pt-2"
          />
        </div>
      </n-tab-pane>

      <!-- ② 验证码聚合视图 -->
      <n-tab-pane name="codes" :tab="t('tabs.codes')">
        <div class="space-y-4 pt-2">
          <div class="flex flex-wrap items-end gap-3 bg-zinc-50/60 dark:bg-zinc-900/40 p-4 rounded-2xl border border-zinc-200/60 dark:border-zinc-800/60">
            <div class="flex flex-col gap-1">
              <span class="text-xs text-zinc-500">{{ t('codes.addrLabel') }}</span>
              <n-input
                v-model:value="codesAddr"
                size="small"
                :placeholder="t('codes.addrPlaceholder')"
                clearable
                style="width: 260px"
                @keyup.enter="loadCodes"
              />
            </div>
            <div class="flex flex-col gap-1">
              <span class="text-xs text-zinc-500">{{ t('list.fresh') }}</span>
              <n-select v-model:value="codesFresh" size="small" :options="freshOptions" style="width: 120px" />
            </div>
            <n-button type="primary" size="small" ghost :loading="codesLoading" @click="loadCodes">
              {{ t('codes.refresh') }}
            </n-button>
          </div>

          <div v-if="codesError && !codes.length" class="text-sm text-rose-500 py-12 text-center">
            {{ codesError }}
          </div>
          <n-empty
            v-else-if="!codesLoading && !codes.length"
            :description="t('codes.empty')"
            class="py-16"
          />
          <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div
              v-for="(c, i) in codes"
              :key="i"
              class="rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white dark:bg-zinc-900/60 p-4 flex items-start justify-between gap-3 shadow-xs hover:border-emerald-500/40 transition-all"
            >
              <div class="min-w-0 space-y-1">
                <div class="font-mono text-2xl font-bold text-emerald-600 dark:text-emerald-400 tracking-widest break-all select-all">
                  {{ c.code }}
                </div>
                <div class="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate">
                  {{ c.subject || t('list.noSubject') }}
                </div>
                <div class="text-xs text-zinc-400 truncate">
                  {{ c.from_addr }} · {{ fmtTime(c.received_at) }}
                </div>
              </div>
              <button
                type="button"
                @click="copyCode(i, c.code)"
                class="px-3 py-1.5 rounded-xl text-xs font-medium border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-200 transition-colors cursor-pointer shrink-0"
              >
                {{ copiedIndex === i ? t('codes.copied') : t('codes.copy') }}
              </button>
            </div>
          </div>
        </div>
      </n-tab-pane>

      <!-- ③ 聚合器运行状态 -->
      <n-tab-pane name="status" :tab="t('tabs.status')">
        <div class="space-y-4 pt-2">
          <div class="flex items-center justify-between flex-wrap gap-2">
            <p class="text-xs text-zinc-500 dark:text-zinc-400 max-w-2xl">{{ t('status.mode') }}</p>
            <n-button size="small" :loading="statusLoading" @click="loadStatus">
              <template #icon><n-icon><RefreshRound /></n-icon></template>
              {{ t('codes.refresh') }}
            </n-button>
          </div>

          <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div class="rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white dark:bg-zinc-900/60 p-4 shadow-xs">
              <div class="text-xs text-zinc-500 flex items-center gap-1.5">
                <span>✉️</span>
                <span>{{ t('status.emails') }}</span>
              </div>
              <div class="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mt-2 font-mono">{{ status.emails }}</div>
            </div>
            <div class="rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white dark:bg-zinc-900/60 p-4 shadow-xs">
              <div class="text-xs text-zinc-500 flex items-center gap-1.5">
                <span>📬</span>
                <span>{{ t('status.unread') }}</span>
              </div>
              <div class="text-2xl font-bold text-emerald-600 dark:text-emerald-400 mt-2 font-mono">{{ status.unread }}</div>
            </div>
            <div class="rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white dark:bg-zinc-900/60 p-4 shadow-xs">
              <div class="text-xs text-zinc-500 flex items-center gap-1.5">
                <span>🌐</span>
                <span>{{ t('status.sources') }}</span>
              </div>
              <div class="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mt-2 font-mono">{{ status.sources.length }}</div>
            </div>
            <div class="rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white dark:bg-zinc-900/60 p-4 shadow-xs">
              <div class="text-xs text-zinc-500 flex items-center gap-1.5">
                <span>👥</span>
                <span>{{ t('status.accounts') }}</span>
              </div>
              <div class="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mt-2 font-mono">{{ status.accounts.length }}</div>
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
      <n-tab-pane name="settings" :tab="t('tabs.settings')">
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 pt-2">
          <div class="rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white dark:bg-zinc-900/60 p-5 space-y-3 shadow-xs">
            <h3 class="text-sm font-semibold text-zinc-800 dark:text-zinc-200 flex items-center gap-2">
              <span>🔑</span>
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
              <span>✨</span>
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
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { SearchRound, RefreshRound } from '@vicons/material'
import { useScopedI18n } from '../i18n/app'
import { api } from '../api'
import { useGlobalState } from '../store'
import StatusIndicator from '../components/ai/StatusIndicator.vue'
import PromptChips from '../components/ai/PromptChips.vue'
import { useMessage } from 'naive-ui'

const { t } = useScopedI18n('unified')
const { unifiedApiKey, adminAuth, userJwt, userSettings } = useGlobalState()
const router = useRouter()
const message = useMessage()

const isLoggedIn = computed(() => !!userJwt.value?.trim())
const hasKey = computed(() => !!unifiedApiKey.value?.trim())
const hasAccess = computed(() => isLoggedIn.value || hasKey.value)

// Quick filter chips
const quickFilterChips = ['📬 全部邮件', '⭐ 星标邮件', '🟢 仅未读', '🔑 提取验证码', '🔄 刷新列表']

const handleSelectChip = (chip) => {
  if (chip.includes('全部邮件')) {
    unreadOnly.value = false
    starOnly.value = false
    sourceFilter.value = null
    accountFilter.value = null
    q.value = ''
    applyFilter()
  } else if (chip.includes('星标邮件')) {
    starOnly.value = true
    applyFilter()
  } else if (chip.includes('仅未读')) {
    unreadOnly.value = true
    applyFilter()
  } else if (chip.includes('提取验证码')) {
    activeTab.value = 'codes'
  } else if (chip.includes('刷新列表')) {
    refreshList()
  }
}

// ---- 顶部连接状态徽标 ----
const connected = ref(false)
const connStatus = computed(() => {
  if (!hasAccess.value) return 'offline'
  if (connected.value) return 'online'
  return 'connecting'
})
const connLabel = computed(() => {
  if (!hasAccess.value) return t('status.offline')
  if (connected.value) return t('status.online')
  return t('status.connecting')
})

const activeTab = ref('list')

// ---- 邮件列表 ----
const PAGE_SIZE = 20
const emails = ref([])
const count = ref(0)
const loading = ref(false)
const listError = ref('')
const page = ref(1)
const q = ref('')
const sourceFilter = ref(null)
const accountFilter = ref(null)
const unreadOnly = ref(false)
const starOnly = ref(false)

const filterParams = computed(() => {
  const p = {
    source: sourceFilter.value || undefined,
    unread: unreadOnly.value ? 1 : undefined,
    starred: starOnly.value ? 1 : undefined,
    q: q.value.trim() || undefined,
  }
  if (accountFilter.value) {
    if (accountFilter.value.includes('@')) {
      p.to_addr = accountFilter.value
    } else {
      p.account_id = accountFilter.value
    }
  }
  return p
})
const listParams = computed(() => ({
  ...filterParams.value,
  limit: PAGE_SIZE,
  offset: (page.value - 1) * PAGE_SIZE,
}))
const filterActive = computed(() => !!(
  filterParams.value.source ||
  filterParams.value.account_id ||
  filterParams.value.to_addr ||
  filterParams.value.unread ||
  filterParams.value.starred ||
  filterParams.value.q
))

let listRequestSeq = 0
const loadList = async () => {
  const requestId = ++listRequestSeq
  if (!hasAccess.value) return
  const requestedPage = page.value
  const requestedParams = listParams.value
  loading.value = true
  listError.value = ''
  try {
    const listRes = await api.unified.listEmails(requestedParams)
    if (requestId !== listRequestSeq) return
    emails.value = listRes.results || []
    // The first page already includes the scoped count; avoid a second full-table scan.
    if (requestedPage === 1 && typeof listRes.count === 'number') {
      count.value = listRes.count
    }
    connected.value = true
    lastLoaded.value = new Date()
  } catch (e) {
    if (requestId !== listRequestSeq) return
    listError.value = e.message || 'error'
    connected.value = false
    emails.value = []
    count.value = 0
  } finally {
    if (requestId === listRequestSeq) loading.value = false
  }
}

const refreshList = () => loadList()
const applySearch = () => { page.value = 1; loadList() }
const applyFilter = () => { page.value = 1; loadList() }
const setPage = (p) => { page.value = p; loadList() }
const openDetail = (id) => router.push({ path: `/unified/${id}` })

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
    const val = a.username || a.id
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

const optionsError = ref('')
let optionsScope = ''
let optionsPromise = null
let optionsPromiseIdentity = ''
let optionsGeneration = 0

const authIdentity = computed(() => {
  const jwt = userJwt.value?.trim()
  if (jwt) return `user:${jwt}`
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
  if (!identity) {
    resetOptions()
    return
  }
  if (optionsScope === identity && !optionsError.value) return
  if (optionsPromise && optionsPromiseIdentity === identity) return optionsPromise
  const generation = ++optionsGeneration
  optionsError.value = ''
  const promise = (async () => {
    const current = () => generation === optionsGeneration && identity === authIdentity.value
    const tasks = []
    if (isLoggedIn.value) {
      tasks.push(api.userMailAccounts.list().then(res => {
        if (current()) userAccounts.value = res.results || []
      }))
      tasks.push(api.fetch('/user_api/bind_address').then(res => {
        if (current()) boundAddresses.value = res.results || []
      }))
    }
    tasks.push(api.unified.meta().then(res => {
      if (!current()) return
      const rows = []
      ;(res.sources || []).forEach(source => rows.push({ source }))
      ;(res.accounts || []).forEach(account_id => rows.push({ account_id }))
      ;(res.to_addrs || []).forEach(to_addr => rows.push({ to_addr }))
      optionRows.value = rows
    }))
    const results = await Promise.allSettled(tasks)
    if (!current()) return
    if (results.some(result => result.status === 'rejected')) {
      throw new Error('筛选项加载失败，请重试')
    }
    optionsScope = identity
  })()
  const handledPromise = promise.catch(error => {
    if (generation === optionsGeneration && identity === authIdentity.value) {
      optionsScope = ''
      optionsError.value = error.message || '筛选项加载失败，请重试'
    }
    return null
  })
  optionsPromise = handledPromise
  optionsPromiseIdentity = identity
  handledPromise.finally(() => {
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
const copiedIndex = ref(-1)
const freshOptions = [
  { label: '10 min', value: 10 },
  { label: '1 h', value: 60 },
  { label: '24 h', value: 1440 },
]

const loadCodes = async () => {
  if (!hasAccess.value) return
  if (!codesAddr.value.trim()) {
    codesError.value = t('codes.empty')
    codes.value = []
    return
  }
  codesLoading.value = true
  codesError.value = ''
  try {
    const res = await api.unified.verifcodes(codesAddr.value.trim(), codesFresh.value * 60 * 1000)
    codes.value = res.results || []
    connected.value = true
  } catch (e) {
    codesError.value = e.message || 'error'
    connected.value = false
    codes.value = []
  } finally {
    codesLoading.value = false
  }
}

const copyCode = async (index, code) => {
  try {
    await navigator.clipboard.writeText(code)
    copiedIndex.value = index
    setTimeout(() => { copiedIndex.value = -1 }, 1500)
  } catch (e) {
    message.error(t('codes.copyFailed'))
  }
}

// ---- 聚合器状态 ----
const status = ref({ emails: 0, unread: 0, sources: [], accounts: [] })
const statusLoading = ref(false)
const statusError = ref('')
const lastRefresh = ref(null)
// This records the last successful read from the unified API, not upstream sync time.
const lastLoaded = ref(null)

const loadStatus = async () => {
  if (!hasAccess.value) return
  statusLoading.value = true
  statusError.value = ''
  try {
    const stats = await api.unified.stats({})
    if (!accountOptions.value.length && !sourceOptions.value.length) {
      await loadOptions()
    }
    status.value = {
      emails: stats.count || 0,
      unread: stats.unread || 0,
      sources: sourceOptions.value.map(s => s.value),
      accounts: accountOptions.value.map(a => a.label || a.value),
    }
    lastRefresh.value = new Date()
    lastLoaded.value = lastRefresh.value
    connected.value = true
  } catch (e) {
    statusError.value = e.message || 'error'
    connected.value = false
  } finally {
    statusLoading.value = false
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
  if (!unifiedApiKey.value.trim()) {
    message.error(t('settings.required'))
    return
  }
  testing.value = true
  try {
    await api.unified.count({})
    connected.value = true
    message.success(t('settings.testOk'))
  } catch (e) {
    connected.value = false
    message.error(`${t('settings.testFail')}: ${e.message}`)
  } finally {
    testing.value = false
  }
}

const createKey = async () => {
  creating.value = true
  const prevAdmin = adminAuth.value
  try {
    if (newKeyAdminPassword.value) adminAuth.value = newKeyAdminPassword.value
    const res = await api.admin.createUnifiedKey({
      name: newKeyName.value.trim(),
      role: newKeyRole.value,
    })
    newKeyPlain.value = res.key
    unifiedApiKey.value = res.key
    keyInput.value = res.key
    connected.value = true
    message.success(t('settings.created'))
  } catch (e) {
    message.error(e.message || 'error')
  } finally {
    adminAuth.value = prevAdmin
    creating.value = false
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
  resetOptions()
  connected.value = false
  if (!identity) {
    listRequestSeq += 1
    emails.value = []
    count.value = 0
    return
  }
  void loadOptions()
  refreshCurrent()
})

onMounted(async () => {
  if (userJwt.value && !userSettings.value.user_id) {
    await api.getUserSettings(message)
  }
  if (hasAccess.value) {
    await loadOptions()
    await loadList()
  }
})
</script>

<style scoped>
.unified-tabs {
  --n-bar-color: #18181b;
}
.dark .unified-tabs {
  --n-bar-color: #f4f4f5;
}
</style>
