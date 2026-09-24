<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import { useGlobalState } from '../store'
import { api } from '../api'

// 域名邮箱全域工作台：任意拼一个前缀 + 选一个本站域名，即可查看该域名下
// 所有收件（catch-all 入库的 cf_routing 邮件），无需预先注册地址。
// 数据面走 /api/unified/emails 的 domain 过滤（管理员 JWT 不加租户收窄）。

const { openSettings, userJwt, unifiedApiKey } = useGlobalState()
const router = useRouter()
const message = useMessage()

const hasAccess = computed(() => Boolean(userJwt.value || unifiedApiKey.value))

// ---- 地址工坊 ----
const name = ref('')
const domain = ref('')
const addressOnly = ref(false)
const domainOptions = computed(() =>
    (openSettings.value.domains || []).map(d => ({ label: d.label || d.value, value: d.value }))
)
const noDomainsConfigured = computed(() =>
    openSettings.value.fetched === true && domainOptions.value.length === 0
)
const fullAddress = computed(() => {
    const n = name.value.trim()
    return n && domain.value ? `${n}@${domain.value}` : ''
})

const copyAddress = async () => {
    if (!fullAddress.value) return
    try {
        await navigator.clipboard.writeText(fullAddress.value)
        message.success('地址已复制')
    } catch {
        message.error('复制失败，请手动选择复制')
    }
}

// ---- 邮件列表（keyset cursor 增量加载，避免深分页打爆 D1 读配额） ----
const PAGE_SIZE = 20
const emails = ref([])
const nextCursor = ref('')
const loading = ref(false)
const loadingMore = ref(false)
const listError = ref('')
let listRequestSeq = 0
let backgroundListPending = false

// 请求参数单源：刷新只由 listSignature（参数 JSON）变化驱动。
// 全域模式下在名字输入框打字不改变参数，因此不会产生无效请求（防 watch 风暴）。
const listParams = computed(() => ({
    domain: domain.value,
    limit: PAGE_SIZE,
    ...(addressOnly.value && fullAddress.value ? { to_addr: fullAddress.value } : {}),
}))
const listSignature = computed(() => JSON.stringify(listParams.value))

const loadList = async ({ background = false } = {}) => {
    if (!hasAccess.value || !domain.value) return
    if (background && backgroundListPending) return
    const requestId = ++listRequestSeq
    if (background) {
        backgroundListPending = true
    } else {
        loading.value = true
    }
    try {
        const res = await api.unified.listEmails(listParams.value)
        if (requestId !== listRequestSeq) return
        emails.value = res.results || []
        nextCursor.value = res.next_cursor || ''
        listError.value = ''
    } catch (e) {
        if (requestId !== listRequestSeq) return
        if (!background) {
            listError.value = e.message || '加载失败'
            emails.value = []
            nextCursor.value = ''
        }
    } finally {
        if (background) backgroundListPending = false
        if (!background) loading.value = false
    }
}

const loadMore = async () => {
    if (!nextCursor.value || loadingMore.value) return
    loadingMore.value = true
    try {
        const res = await api.unified.listEmails({ ...listParams.value, cursor: nextCursor.value })
        const rows = res.results || []
        const seen = new Set(emails.value.map(r => r.id))
        emails.value = [...emails.value, ...rows.filter(r => !seen.has(r.id))]
        nextCursor.value = res.next_cursor || ''
    } catch (e) {
        message.error(e.message || '加载更多失败')
    } finally {
        loadingMore.value = false
    }
}

// ---- 验证码聚合（全域模式复用 verifcodes 的 domain 过滤） ----
const codes = ref([])
const codesLoading = ref(false)
let codesRequestSeq = 0
let backgroundCodesPending = false

const loadCodes = async ({ background = false } = {}) => {
    if (!hasAccess.value) return
    const addr = addressOnly.value && fullAddress.value ? fullAddress.value : ''
    if (!addr && !domain.value) return
    if (background && backgroundCodesPending) return
    const requestId = ++codesRequestSeq
    if (background) {
        backgroundCodesPending = true
    } else {
        codesLoading.value = true
    }
    try {
        const res = await api.unified.verifcodes(addr, 10 * 60 * 1000, addr ? '' : domain.value)
        if (requestId !== codesRequestSeq) return
        codes.value = res.results || []
    } catch {
        // 验证码聚合失败不打断主列表
    } finally {
        if (background) backgroundCodesPending = false
        if (!background) codesLoading.value = false
    }
}

// ---- 自动刷新 ----
const AUTO_REFRESH_MS = 30000
const autoRefresh = ref(true)
let timer = null

const startTimer = () => {
    stopTimer()
    timer = setInterval(() => {
        if (autoRefresh.value) {
            loadList({ background: true })
            loadCodes({ background: true })
        }
    }, AUTO_REFRESH_MS)
}
const stopTimer = () => {
    if (timer) { clearInterval(timer); timer = null }
}

const refreshAll = () => {
    loadList()
    loadCodes()
}

// 刷新只由请求参数签名驱动（见 listSignature），打字不触发无效刷新
watch(listSignature, () => {
    nextCursor.value = ''
    refreshAll()
})

// openSettings 原本由 Index/UserLogin 等页面按需加载；本页自持该依赖，
// 书签/新标签直达 /domain-mailbox 时也能拿到域名下拉并补选默认域
const ensureSettings = async () => {
    if (openSettings.value.fetched) return
    try {
        await api.getOpenSettings(message)
    } catch {
        // 拉取失败保持空下拉，页面会显示无域名提示，用户可重进页面重试
    }
}

watch(domainOptions, (opts) => {
    if (!domain.value && opts.length) domain.value = opts[0].value
})

const copyCode = async (code) => {
    try {
        await navigator.clipboard.writeText(code)
        message.success('验证码已复制')
    } catch {
        message.error('复制失败')
    }
}

const openDetail = (id) => {
    router.push(`/unified/${encodeURIComponent(id)}`)
}

const fmtTime = (ms) => {
    if (!ms) return ''
    const d = new Date(Number(ms))
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
}

onMounted(async () => {
    await ensureSettings()
    if (!domain.value && domainOptions.value.length) {
        domain.value = domainOptions.value[0].value
    }
    refreshAll()
    startTimer()
})
onUnmounted(stopTimer)
</script>

<template>
  <div class="domain-mailbox max-w-4xl mx-auto px-4 py-6 text-left space-y-5">
    <!-- 未登录提示 -->
    <n-alert v-if="!hasAccess" type="warning" :show-icon="false" class="rounded-2xl">
      <div class="flex items-center justify-between gap-3">
        <span>请先登录管理员账号后使用域名邮箱工作台</span>
        <n-button size="small" type="primary" @click="router.push('/user')">去登录</n-button>
      </div>
    </n-alert>

    <template v-else>
      <!-- 后端未返回任何域名（DOMAINS 未配置/为空）时的显式告警 -->
      <n-alert v-if="noDomainsConfigured" type="warning" :show-icon="false" class="rounded-2xl">
        后端没有返回可用域名——请检查 Worker 的 DOMAINS 环境变量配置
      </n-alert>

      <!-- ① 地址工坊 -->
      <div class="rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white dark:bg-zinc-900/60 shadow-xs p-5 space-y-4">
        <div class="flex items-center justify-between">
          <div class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">域名邮箱 · 全域接码</div>
          <div class="flex items-center gap-3">
            <n-switch v-model:value="autoRefresh" size="small">
              <template #checked>30s 自动刷新</template>
              <template #unchecked>手动刷新</template>
            </n-switch>
            <n-button size="small" quaternary :loading="loading" @click="refreshAll">刷新</n-button>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <n-input
            v-model:value="name"
            placeholder="随便写邮箱名，如 github / shop001"
            clearable
            class="w-56"
          >
            <template #prefix><span class="text-zinc-400 text-xs">✉️</span></template>
          </n-input>
          <span class="text-zinc-400 font-mono">@</span>
          <n-select
            v-model:value="domain"
            :options="domainOptions"
            placeholder="选择域名"
            class="w-56"
            filterable
          />
          <n-button v-if="fullAddress" size="small" type="primary" secondary @click="copyAddress">
            复制完整地址
          </n-button>
        </div>

        <div v-if="fullAddress" class="flex items-center gap-3 flex-wrap">
          <span class="px-3 py-1.5 rounded-xl bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700 text-sm font-mono text-zinc-800 dark:text-zinc-200">
            {{ fullAddress }}
          </span>
          <n-checkbox v-model:checked="addressOnly" size="small">
            只看这个地址（关闭 = 该域名下全部邮件）
          </n-checkbox>
        </div>
        <div v-else class="text-xs text-zinc-500 dark:text-zinc-400">
          输入前缀并选择域名后可复制地址对外使用；不输入前缀时直接查看所选域名的全域邮件。
        </div>
      </div>

      <!-- ② 验证码聚合 -->
      <div
        v-if="codes.length"
        class="rounded-2xl border border-emerald-200/60 dark:border-emerald-800/40 bg-emerald-50/60 dark:bg-emerald-950/20 p-5 space-y-3"
      >
        <div class="flex items-center gap-2">
          <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
          <div class="text-sm font-semibold text-emerald-700 dark:text-emerald-400">近 10 分钟验证码</div>
          <n-spin v-if="codesLoading" :size="14" />
        </div>
        <div class="grid gap-2 sm:grid-cols-2">
          <button
            v-for="(c, i) in codes"
            :key="i"
            type="button"
            class="text-left px-4 py-3 rounded-xl bg-white dark:bg-zinc-900/70 border border-emerald-200/70 dark:border-emerald-800/40 hover:border-emerald-400 transition-colors cursor-pointer"
            @click="copyCode(c.code)"
          >
            <div class="flex items-center justify-between gap-3">
              <span class="text-xl font-mono font-bold tracking-widest text-emerald-600 dark:text-emerald-400">{{ c.code }}</span>
              <span class="text-[10px] text-zinc-400 font-mono shrink-0">{{ fmtTime(c.received_at) }}</span>
            </div>
            <div class="text-xs text-zinc-500 dark:text-zinc-400 truncate mt-1">
              {{ c.from_addr }} · {{ c.subject }}
            </div>
          </button>
        </div>
      </div>

      <!-- ③ 全域邮件列表 -->
      <div class="space-y-2">
        <div class="flex items-center justify-between px-1">
          <span class="text-xs text-zinc-500 dark:text-zinc-400">
            {{ addressOnly && fullAddress ? fullAddress : domain }} 的收件
          </span>
          <span class="text-xs text-zinc-400 font-mono">{{ emails.length }} 封</span>
        </div>

        <div v-if="loading" class="py-16 text-center text-zinc-400">
          <span class="animate-spin text-xl">⏳</span>
        </div>
        <div v-else-if="listError" class="py-12 text-center text-sm text-rose-500">
          <div>{{ listError }}</div>
          <n-button size="small" class="mt-3" @click="refreshAll">重试</n-button>
        </div>
        <n-empty
          v-else-if="!emails.length"
          description="该范围暂无邮件——把上面复制的地址填到任意注册页，邮件到达后这里秒级出现"
          class="py-16"
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
            <div class="min-w-0 flex-1 space-y-1">
              <div class="flex items-baseline gap-2 flex-wrap">
                <span class="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                  {{ row.subject || '（无主题）' }}
                </span>
                <n-tag size="tiny" :bordered="false" class="shrink-0 font-mono">{{ row.account_id }}</n-tag>
              </div>
              <div class="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                {{ row.from_addr }}
              </div>
            </div>
            <div class="text-xs text-zinc-400 shrink-0 font-mono">{{ fmtTime(row.received_at) }}</div>
          </button>
        </div>

        <div v-if="nextCursor" class="text-center pt-1">
          <n-button size="small" quaternary :loading="loadingMore" @click="loadMore">
            加载更多
          </n-button>
        </div>
      </div>
    </template>
  </div>
</template>
