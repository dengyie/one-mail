<template>
  <div class="unified-inbox max-w-6xl mx-auto px-4 py-6 text-left">
    <!-- 页头 -->
    <div class="flex items-center justify-between flex-wrap gap-3 mb-4">
      <div>
        <h1 class="text-xl font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
          <span>📥</span>
          <span>{{ t('title') }}</span>
        </h1>
        <p class="text-sm text-zinc-500 dark:text-zinc-400 mt-0.5">{{ t('subtitle') }}</p>
      </div>
      <StatusIndicator :status="connStatus" :label="connLabel" />
    </div>

    <!-- 未配置 API-key 提示 -->
    <div
      v-if="!hasKey"
      class="rounded-xl border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 px-4 py-3 text-sm mb-4 flex items-center justify-between gap-3"
    >
      <span>{{ t('status.noKey') }}</span>
      <n-button size="small" type="primary" ghost @click="activeTab = 'settings'">
        {{ t('tabs.settings') }}
      </n-button>
    </div>

    <n-tabs v-model:value="activeTab" type="segment" class="unified-tabs">
      <!-- ① 邮件列表 -->
      <n-tab-pane name="list" :tab="t('tabs.list')">
        <div class="space-y-3">
          <!-- 过滤 / 搜索 / 分页控制 -->
          <div class="flex flex-wrap items-center gap-2">
            <n-input
              v-model:value="q"
              :placeholder="t('list.searchPlaceholder')"
              clearable
              style="max-width: 280px"
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
              :placeholder="t('list.allSources')"
              style="width: 150px"
              @update:value="applyFilter"
            />
            <n-select
              v-model:value="accountFilter"
              :options="accountOptions"
              clearable
              :placeholder="t('list.allAccounts')"
              style="width: 210px"
              @update:value="applyFilter"
            />
            <n-checkbox v-model:checked="unreadOnly" @update:checked="applyFilter">
              {{ t('list.unread') }}
            </n-checkbox>
            <div class="flex-1"></div>
            <span class="text-xs text-zinc-400">{{ t('list.total', { count }) }}</span>
            <n-button size="small" :loading="loading" @click="refreshList">
              <template #icon><n-icon><RefreshRound /></n-icon></template>
            </n-button>
          </div>

          <div v-if="loading" class="py-16 text-center text-zinc-400">
            {{ t('list.loading') }}
          </div>
          <n-empty
            v-else-if="!emails.length"
            :description="filterActive ? t('list.emptyFiltered') : t('list.empty')"
            class="py-16"
          />
          <div
            v-else
            class="rounded-xl border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-800/70 overflow-hidden bg-white dark:bg-zinc-900/60"
          >
            <button
              v-for="row in emails"
              :key="row.id"
              class="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors"
              @click="openDetail(row.id)"
            >
              <span
                class="w-2 h-2 rounded-full shrink-0"
                :class="row.is_read ? 'bg-transparent' : 'bg-emerald-500'"
              ></span>
              <div class="min-w-0 flex-1">
                <div class="flex items-baseline gap-2">
                  <span class="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate">
                    {{ row.subject || t('list.noSubject') }}
                  </span>
                  <n-tag size="small" :bordered="false" type="info" class="shrink-0">{{ row.source }}</n-tag>
                </div>
                <div class="text-xs text-zinc-500 dark:text-zinc-400 truncate mt-0.5">
                  {{ row.from_addr }}<span v-if="row.account_id"> → {{ row.account_id }}</span>
                </div>
              </div>
              <div class="text-xs text-zinc-400 shrink-0">{{ fmtTime(row.received_at) }}</div>
            </button>
          </div>

          <n-pagination
            v-if="count > pageSize"
            :page="page"
            :page-count="Math.ceil(count / pageSize)"
            :page-size="pageSize"
            @update:page="setPage"
            class="justify-center"
          />
        </div>
      </n-tab-pane>

      <!-- ② 验证码聚合视图 -->
      <n-tab-pane name="codes" :tab="t('tabs.codes')">
        <div class="space-y-3">
          <div class="flex flex-wrap items-end gap-2">
            <div class="flex flex-col gap-1">
              <span class="text-xs text-zinc-500">{{ t('codes.addrLabel') }}</span>
              <n-input
                v-model:value="codesAddr"
                :placeholder="t('codes.addrPlaceholder')"
                clearable
                style="width: 260px"
                @keyup.enter="loadCodes"
              />
            </div>
            <div class="flex flex-col gap-1">
              <span class="text-xs text-zinc-500">{{ t('list.fresh') }}</span>
              <n-select v-model:value="codesFresh" :options="freshOptions" style="width: 120px" />
            </div>
            <n-button type="primary" ghost :loading="codesLoading" @click="loadCodes">
              {{ t('codes.refresh') }}
            </n-button>
          </div>

          <div v-if="codesError && !codes.length" class="text-sm text-rose-500 py-8 text-center">
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
              class="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-4 flex items-start justify-between gap-3"
            >
              <div class="min-w-0">
                <div class="font-mono text-2xl font-bold text-zinc-900 dark:text-zinc-100 tracking-widest break-all">
                  {{ c.code }}
                </div>
                <div class="text-sm text-zinc-700 dark:text-zinc-300 truncate mt-1">
                  {{ c.subject || t('list.noSubject') }}
                </div>
                <div class="text-xs text-zinc-400 truncate">
                  {{ c.from_addr }} · {{ fmtTime(c.received_at) }}
                </div>
              </div>
              <n-button size="small" quaternary @click="copyCode(i, c.code)">
                {{ copiedIndex === i ? t('codes.copied') : t('codes.copy') }}
              </n-button>
            </div>
          </div>
        </div>
      </n-tab-pane>

      <!-- ③ 聚合器运行状态 -->
      <n-tab-pane name="status" :tab="t('tabs.status')">
        <div class="space-y-3">
          <div class="flex items-center justify-between flex-wrap gap-2">
            <p class="text-sm text-zinc-500 dark:text-zinc-400 max-w-2xl">{{ t('status.mode') }}</p>
            <n-button size="small" :loading="statusLoading" @click="loadStatus">
              <template #icon><n-icon><RefreshRound /></n-icon></template>
              {{ t('codes.refresh') }}
            </n-button>
          </div>

          <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div class="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-4">
              <div class="text-xs text-zinc-500">{{ t('status.emails') }}</div>
              <div class="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mt-1">{{ status.emails }}</div>
            </div>
            <div class="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-4">
              <div class="text-xs text-zinc-500">{{ t('status.unread') }}</div>
              <div class="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mt-1">{{ status.unread }}</div>
            </div>
            <div class="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-4">
              <div class="text-xs text-zinc-500">{{ t('status.sources') }}</div>
              <div class="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mt-1">{{ status.sources.length }}</div>
            </div>
            <div class="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-4">
              <div class="text-xs text-zinc-500">{{ t('status.accounts') }}</div>
              <div class="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mt-1">{{ status.accounts.length }}</div>
            </div>
          </div>

          <div
            v-if="status.sources.length"
            class="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-4"
          >
            <div class="text-xs text-zinc-500 mb-2">{{ t('status.sources') }}</div>
            <div class="flex flex-wrap gap-2">
              <n-tag v-for="s in status.sources" :key="s" size="small" :bordered="false">{{ s }}</n-tag>
            </div>
          </div>

          <div v-if="statusError && !status.emails" class="text-sm text-rose-500">
            {{ statusError }}
          </div>
          <div v-if="lastRefresh" class="text-xs text-zinc-400">
            {{ t('status.lastRefresh', { time: fmtTime(lastRefresh.getTime()) }) }}
          </div>
        </div>
      </n-tab-pane>

      <!-- ④ API-key 设置 -->
      <n-tab-pane name="settings" :tab="t('tabs.settings')">
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div class="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-5 space-y-3">
            <h3 class="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{{ t('settings.title') }}</h3>
            <p class="text-xs text-zinc-500">{{ t('settings.keyTip') }}</p>
            <n-input
              v-model:value="keyInput"
              type="password"
              show-password-on="click"
              :placeholder="t('settings.keyPlaceholder')"
            />
            <div class="flex gap-2">
              <n-button type="primary" @click="saveKey">{{ t('settings.save') }}</n-button>
              <n-button :loading="testing" @click="testKey">{{ t('settings.test') }}</n-button>
            </div>
          </div>

          <div class="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-5 space-y-3">
            <h3 class="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{{ t('settings.createKey') }}</h3>
            <p class="text-xs text-zinc-500">{{ t('settings.createKeyTip') }}</p>
            <n-input v-model:value="newKeyName" :placeholder="t('settings.keyNamePlaceholder')" />
            <n-select v-model:value="newKeyRole" :options="roleOptions" />
            <n-input
              v-model:value="newKeyAdminPassword"
              type="password"
              show-password-on="click"
              :placeholder="t('settings.adminPasswordPlaceholder')"
            />
            <n-button
              type="primary"
              :loading="creating"
              :disabled="!newKeyName.trim() || !newKeyAdminPassword"
              @click="createKey"
            >
              {{ t('settings.create') }}
            </n-button>
            <div
              v-if="newKeyPlain"
              class="rounded-lg bg-zinc-900 dark:bg-zinc-800 text-emerald-400 font-mono text-xs p-3 break-all select-all"
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

const { t } = useScopedI18n('unified')
const { unifiedApiKey, adminAuth } = useGlobalState()
const router = useRouter()
const message = useMessage()

const hasKey = computed(() => !!unifiedApiKey.value?.trim())

// ---- 顶部连接状态徽标 ----
const connected = ref(false)
const connStatus = computed(() => {
  if (!hasKey.value) return 'offline'
  if (connected.value) return 'online'
  return 'connecting'
})
const connLabel = computed(() => {
  if (!hasKey.value) return t('status.offline')
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

const filterParams = computed(() => ({
  source: sourceFilter.value || undefined,
  account_id: accountFilter.value || undefined,
  unread: unreadOnly.value ? 1 : undefined,
  q: q.value.trim() || undefined,
}))
const listParams = computed(() => ({
  ...filterParams.value,
  limit: PAGE_SIZE,
  offset: (page.value - 1) * PAGE_SIZE,
}))
const filterActive = computed(() => !!(filterParams.value.source || filterParams.value.account_id || filterParams.value.unread || filterParams.value.q))

const loadList = async () => {
  if (!hasKey.value) return
  loading.value = true
  listError.value = ''
  try {
    const [listRes, countRes] = await Promise.all([
      api.unified.listEmails(listParams.value),
      api.unified.count(filterParams.value),
    ])
    emails.value = listRes.results || []
    count.value = countRes.count || 0
    connected.value = true
  } catch (e) {
    listError.value = e.message || 'error'
    connected.value = false
    emails.value = []
    count.value = 0
  } finally {
    loading.value = false
  }
}

const refreshList = () => loadList()
const applySearch = () => { page.value = 1; loadList() }
const applyFilter = () => { page.value = 1; loadList() }
const setPage = (p) => { page.value = p; loadList() }
const openDetail = (id) => router.push({ path: `/unified/${id}` })

// 来源/账号筛选项（从最近一批邮件里推导，避免枚举接口）
const optionRows = ref([])
const sourceOptions = computed(() => [...new Set(optionRows.value.map(r => r.source).filter(Boolean))].map(s => ({ label: s, value: s })))
const accountOptions = computed(() => [...new Set(optionRows.value.map(r => r.account_id).filter(Boolean))].map(a => ({ label: a, value: a })))
const loadOptions = async () => {
  if (!hasKey.value) return
  try {
    const res = await api.unified.listEmails({ limit: 300 })
    optionRows.value = res.results || []
    connected.value = true
  } catch { /* 列表页会展示具体错误 */ }
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
  if (!hasKey.value) return
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

const loadStatus = async () => {
  if (!hasKey.value) return
  statusLoading.value = true
  statusError.value = ''
  try {
    const [total, unread, list] = await Promise.all([
      api.unified.count({}),
      api.unified.count({ unread: 1 }),
      api.unified.listEmails({ limit: 500 }),
    ])
    const rows = list.results || []
    status.value = {
      emails: total.count || 0,
      unread: unread.count || 0,
      sources: [...new Set(rows.map(r => r.source).filter(Boolean))],
      accounts: [...new Set(rows.map(r => r.account_id).filter(Boolean))],
    }
    lastRefresh.value = new Date()
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

// key 保存后自动刷新当前视图；首次挂载加载列表
watch(hasKey, (v) => { if (v) { loadOptions(); refreshCurrent() } })

onMounted(() => {
  if (hasKey.value) {
    loadOptions()
    loadList()
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
