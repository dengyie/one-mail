<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import { useGlobalState } from '../store'
import { api } from '../api'
import { useScopedI18n } from '../i18n/app'
import { getRouterPathWithLang, hashPassword } from '../utils'

// 域名邮箱全域工作台：任意拼一个前缀 + 选一个本站域名，即可查看该域名下
// 所有收件（catch-all 入库的 cf_routing 邮件），无需预先注册地址。
// 数据面走 /api/unified/emails 的 domain 过滤（仅限管理员访问）。

const {
    openSettings,
    userJwt,
    unifiedApiKey,
    adminAuth,
    userSettings,
} = useGlobalState()
const router = useRouter()
const message = useMessage()
const { locale } = useScopedI18n('views.Header')

// 权限判定：仅限管理员使用（管理员账号/管理密码/纯 API-Key）
const hasAccess = computed(() => Boolean(
    userSettings.value.is_admin === true ||
    adminAuth.value ||
    (unifiedApiKey.value && !userJwt.value)
))

// 状态判定：
// 1. 凭据检验中：已存有 userJwt 但 userSettings 尚未拉取完毕，避免首帧闪烁拦截
const isCheckingAuth = computed(() => Boolean(userJwt.value && !userSettings.value.fetched && !adminAuth.value))
// 2. 普通登录用户拦截：已登录普通账号但并非管理员
const isForbidden = computed(() => Boolean(userJwt.value && userSettings.value.fetched && !hasAccess.value))
// 3. 未登录访客：没有任何登录凭据
const isUnauthenticated = computed(() => Boolean(!isCheckingAuth.value && !hasAccess.value && !userJwt.value))

// 后台管理密码快速验证
const tmpAdminPassword = ref('')
const adminLoggingIn = ref(false)

const handleAdminPasswordLogin = async () => {
    const pwd = tmpAdminPassword.value.trim()
    if (!pwd) {
        message.warning('请输入管理密码')
        return
    }
    adminLoggingIn.value = true
    try {
        await api.fetch('/open_api/admin_login', {
            method: 'POST',
            body: JSON.stringify({
                password: await hashPassword(pwd),
            })
        })
        adminAuth.value = pwd
        tmpAdminPassword.value = ''
        message.success('管理员认证成功')
    } catch (e) {
        message.error(e.message || '管理密码错误')
    } finally {
        adminLoggingIn.value = false
    }
}

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

const RANDOM_WORDS = [
    'test', 'dev', 'temp', 'box', 'user', 'mail', 'reg', 'shop',
    'app', 'fast', 'safe', 'work', 'code', 'hub', 'star', 'blue'
]

const generateRandomPrefix = () => {
    const word = RANDOM_WORDS[Math.floor(Math.random() * RANDOM_WORDS.length)]
    const num = Math.floor(1000 + Math.random() * 9000)
    name.value = `${word}${num}`
}

const copyText = async (text, successMsg = '已复制') => {
    if (!text) return
    try {
        if (typeof navigator !== 'undefined' && navigator?.clipboard?.writeText) {
            await navigator.clipboard.writeText(text)
            message.success(successMsg)
        } else {
            message.error('当前环境不支持剪贴板复制，请手动复制')
        }
    } catch {
        message.error('复制失败，请手动选择复制')
    }
}

const copyAddress = () => copyText(fullAddress.value, '完整地址已复制')

// 快速根据收件人地址切换/过滤
const filterByAddress = (targetAddr) => {
    if (!targetAddr || typeof targetAddr !== 'string') return
    const match = targetAddr.match(/([^<@\s]+)@([^>@\s]+)/)
    if (!match) return
    const targetPrefix = match[1].trim()
    const targetDomain = match[2].trim().toLowerCase()
    const matchedOption = domainOptions.value.find(opt => opt.value.toLowerCase() === targetDomain)
    if (!matchedOption) {
        message.warning('该邮箱后缀不属于当前站点已配置的域名')
        return
    }
    name.value = targetPrefix
    domain.value = matchedOption.value
    addressOnly.value = true
}

const clearPrefix = () => {
    name.value = ''
    addressOnly.value = false
}

// ---- 搜索与状态过滤 ----
const searchQuery = ref('')
const debouncedSearch = ref('')
let searchDebounceTimer = null
watch(searchQuery, (val) => {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer)
    searchDebounceTimer = setTimeout(() => {
        debouncedSearch.value = val.trim()
    }, 300)
})

const statusFilter = ref('all') // 'all' | 'unread' | 'starred'

// ---- 邮件列表（keyset cursor 增量加载，避免深分页打爆 D1 读配额） ----
const PAGE_SIZE = 20
const emails = ref([])
const nextCursor = ref('')
const loading = ref(false)
const loadingMore = ref(false)
const listError = ref('')
let listRequestSeq = 0
let backgroundListPending = false
let componentDisposed = false

// 请求参数单源：刷新只由 listSignature（参数 JSON）变化驱动。
// 全域模式下在名字输入框打字不改变参数，因此不会产生无效请求（防 watch 风暴）。
const listParams = computed(() => ({
    domain: domain.value,
    limit: PAGE_SIZE,
    ...(addressOnly.value && fullAddress.value ? { to_addr: fullAddress.value } : {}),
    ...(statusFilter.value === 'unread' ? { unread: '1' } : {}),
    ...(statusFilter.value === 'starred' ? { starred: '1' } : {}),
    ...(debouncedSearch.value ? { q: debouncedSearch.value } : {}),
}))
const listSignature = computed(() => JSON.stringify(listParams.value))

const loadList = async ({ background = false } = {}) => {
    if (!hasAccess.value || !domain.value || componentDisposed) return
    if (background && backgroundListPending) return
    const requestId = ++listRequestSeq
    if (background) {
        backgroundListPending = true
    } else {
        loading.value = true
    }
    try {
        const res = await api.unified.listEmails(listParams.value)
        if (requestId !== listRequestSeq || componentDisposed) return
        emails.value = res.results || []
        nextCursor.value = res.next_cursor || ''
        listError.value = ''
    } catch (e) {
        if (requestId !== listRequestSeq || componentDisposed) return
        if (!background) {
            listError.value = e.message || '加载失败'
            emails.value = []
            nextCursor.value = ''
        }
    } finally {
        if (background) {
            backgroundListPending = false
        } else if (requestId === listRequestSeq) {
            loading.value = false
        }
    }
}

const loadMore = async () => {
    if (!nextCursor.value || loadingMore.value || componentDisposed) return
    const requestId = listRequestSeq
    loadingMore.value = true
    try {
        const res = await api.unified.listEmails({ ...listParams.value, cursor: nextCursor.value })
        if (componentDisposed || requestId !== listRequestSeq) return
        const rows = res.results || []
        const seen = new Set(emails.value.map(r => r.id))
        emails.value = [...emails.value, ...rows.filter(r => !seen.has(r.id))]
        nextCursor.value = res.next_cursor || ''
    } catch (e) {
        if (!componentDisposed && requestId === listRequestSeq) {
            message.error(e.message || '加载更多失败')
        }
    } finally {
        if (!componentDisposed) {
            loadingMore.value = false
        }
    }
}

// 快速星标切换（乐观更新）
const toggleStar = async (row, event) => {
    event?.stopPropagation?.()
    const nextVal = row.is_starred ? 0 : 1
    const prevVal = row.is_starred
    row.is_starred = nextVal
    try {
        await api.unified.toggleStar(row.id, nextVal)
    } catch (e) {
        row.is_starred = prevVal
        message.error(e.message || '星标切换失败')
    }
}

// 快速已读/未读切换（乐观更新）
const toggleRead = async (row, event) => {
    event?.stopPropagation?.()
    const nextVal = row.is_read ? 0 : 1
    const prevVal = row.is_read
    row.is_read = nextVal
    try {
        if (nextVal) {
            await api.unified.markRead(row.id)
        } else {
            await api.unified.markUnread(row.id)
        }
    } catch (e) {
        row.is_read = prevVal
        message.error(e.message || '标记失败')
    }
}

// ---- 验证码聚合（全域模式复用 verifcodes 的 domain 过滤） ----
const codes = ref([])
const codesLoading = ref(false)
let codesRequestSeq = 0
let backgroundCodesPending = false

const codeFreshnessMinutes = ref(10) // 10, 60, 1440
const freshnessOptions = [
    { label: '10分钟', value: 10 },
    { label: '1小时', value: 60 },
    { label: '24小时', value: 1440 },
]

watch(codeFreshnessMinutes, () => {
    loadCodes()
})

const loadCodes = async ({ background = false } = {}) => {
    if (!hasAccess.value || componentDisposed) return
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
        const res = await api.unified.verifcodes(addr, codeFreshnessMinutes.value * 60 * 1000, addr ? '' : domain.value)
        if (requestId !== codesRequestSeq || componentDisposed) return
        codes.value = res.results || []
    } catch {
        // 验证码聚合失败不打断主列表
    } finally {
        if (background) {
            backgroundCodesPending = false
        } else if (requestId === codesRequestSeq) {
            codesLoading.value = false
        }
    }
}

// ---- 自动刷新 & 后台可见性防御 ----
const AUTO_REFRESH_MS = 30000
const autoRefresh = ref(true)
let timer = null

const startTimer = () => {
    stopTimer()
    timer = setInterval(() => {
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
            return
        }
        if (autoRefresh.value) {
            loadList({ background: true })
            loadCodes({ background: true })
        }
    }, AUTO_REFRESH_MS)
}

const stopTimer = () => {
    if (timer) { clearInterval(timer); timer = null }
}

const handleVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible' && autoRefresh.value) {
        refreshAll({ background: true })
    }
}

const refreshAll = ({ background = false } = {}) => {
    loadList({ background })
    loadCodes({ background })
}

let refreshScheduled = false
const scheduleRefreshAll = ({ background = false } = {}) => {
    if (refreshScheduled) return
    refreshScheduled = true
    queueMicrotask(() => {
        refreshScheduled = false
        if (componentDisposed || !hasAccess.value || !domain.value) return
        refreshAll({ background })
    })
}

// 刷新由请求参数签名变化驱动，通过 scheduleRefreshAll 进行微任务去重，打字不触发无效刷新
watch(listSignature, () => {
    listRequestSeq += 1
    nextCursor.value = ''
    if (hasAccess.value) {
        scheduleRefreshAll()
    }
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

const ensureValidDomain = (opts) => {
    if (!opts || !opts.length) return
    if (!domain.value || !opts.some(o => o.value === domain.value)) {
        domain.value = opts[0].value
    }
}

watch(domainOptions, (opts) => {
    ensureValidDomain(opts)
}, { immediate: true })

const copyCode = (code) => copyText(code, '验证码已复制: ' + code)

const openDetail = (id) => {
    router.push({
        path: getRouterPathWithLang(`/unified/${encodeURIComponent(id)}`, locale.value),
        query: { from: '/domain-mailbox' },
    })
}

const goToLogin = () => {
    router.push(getRouterPathWithLang('/user', locale.value))
}

const fmtTime = (ms) => {
    if (!ms) return ''
    const d = new Date(Number(ms))
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
}

const hasAttachments = (row) => {
    if (!row.attachments_json) return false
    try {
        const arr = JSON.parse(row.attachments_json)
        return Array.isArray(arr) && arr.length > 0
    } catch {
        return false
    }
}

onMounted(async () => {
    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', handleVisibilityChange)
    }
    await ensureSettings()
    if (userJwt.value && !userSettings.value.user_id) {
        try {
            await api.getUserSettings(message)
        } catch {
            // 异常在 api 内已处理，保持 userSettings.fetched=true
        }
    }
    if (componentDisposed) return
    if (!hasAccess.value) return
    ensureValidDomain(domainOptions.value)
    if (domain.value) {
        scheduleRefreshAll()
        startTimer()
    }
})

watch(hasAccess, (val) => {
    if (val && !componentDisposed) {
        ensureValidDomain(domainOptions.value)
        if (domain.value) {
            scheduleRefreshAll()
            startTimer()
        }
    } else if (!val) {
        stopTimer()
    }
})

onBeforeUnmount(() => {
    componentDisposed = true
    stopTimer()
    if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer)
    listRequestSeq += 1
    codesRequestSeq += 1
})
</script>

<template>
  <div class="domain-mailbox max-w-4xl mx-auto px-4 py-6 text-left space-y-5">
    <!-- 1. 凭据校验加载中状态 -->
    <div v-if="isCheckingAuth" class="p-12 text-center text-slate-500 dark:text-slate-400 space-y-3">
      <n-spin size="large" />
      <p class="text-sm">正在验证管理员访问权限...</p>
    </div>

    <!-- 2. 普通登录用户直接拦截（非管理员禁止访问，支持原地输入管理密码提权） -->
    <div
      v-else-if="isForbidden"
      class="p-8 bg-white/90 dark:bg-slate-900/90 rounded-3xl border border-slate-200/80 dark:border-slate-800/80 text-center max-w-md mx-auto my-12 shadow-sm space-y-4"
    >
      <div class="w-16 h-16 rounded-full bg-rose-500/10 text-rose-500 flex items-center justify-center mx-auto text-2xl font-bold">
        🚫
      </div>
      <h3 class="text-lg font-bold text-slate-900 dark:text-white">暂无管理员权限</h3>
      <p class="text-xs text-slate-500">
        当前账号（{{ userSettings.user_email || '普通用户' }}）并非系统管理员。域名邮箱全域工作台目前仅供站长/管理员使用。若您知晓后台管理密码，可直接在下方验证提权。
      </p>
      <div class="space-y-3 pt-2 text-left">
        <n-input
          v-model:value="tmpAdminPassword"
          type="password"
          show-password-on="click"
          placeholder="请输入后台管理密码原地提权"
          @keyup.enter="handleAdminPasswordLogin"
          class="rounded-xl"
        />
        <n-button
          type="primary"
          block
          :loading="adminLoggingIn"
          @click="handleAdminPasswordLogin"
          class="rounded-xl font-medium"
        >
          验证密码并进入工作台
        </n-button>
        <div class="flex items-center justify-between pt-1">
          <n-button text size="small" @click="router.push(getRouterPathWithLang('/mailbox', locale))">
            &larr; 返回收件箱
          </n-button>
          <n-button text size="small" type="primary" @click="goToLogin">
            切换账号登录 &rarr;
          </n-button>
        </div>
      </div>
    </div>

    <!-- 3. 未登录访客拦截：引导登录管理员账号或输入管理密码 -->
    <div
      v-else-if="isUnauthenticated"
      class="p-8 bg-white/90 dark:bg-slate-900/90 rounded-3xl border border-slate-200/80 dark:border-slate-800/80 text-center max-w-md mx-auto my-12 shadow-sm space-y-4"
    >
      <div class="w-14 h-14 rounded-2xl bg-amber-500/10 text-amber-500 flex items-center justify-center mx-auto text-2xl">
        🔑
      </div>
      <h3 class="text-lg font-bold text-slate-900 dark:text-white">系统管理员访问凭证</h3>
      <p class="text-xs text-slate-500">
        域名邮箱全域工作台目前仅供站长/管理员使用。请登录管理员账号或输入后台管理密码。
      </p>
      <div class="space-y-3 pt-2 text-left">
        <n-input
          v-model:value="tmpAdminPassword"
          type="password"
          show-password-on="click"
          placeholder="请输入后台管理密码"
          @keyup.enter="handleAdminPasswordLogin"
          class="rounded-xl"
        />
        <n-button
          type="primary"
          block
          :loading="adminLoggingIn"
          @click="handleAdminPasswordLogin"
          class="rounded-xl font-medium"
        >
          验证密码并进入
        </n-button>
        <div class="text-center pt-2">
          <n-button text size="small" type="primary" @click="goToLogin">
            使用管理员账号登录 &rarr;
          </n-button>
        </div>
      </div>
    </div>

    <!-- 4. 管理员授权通过，展示全域工作台 -->
    <template v-else>
      <!-- 后端未返回任何域名（DOMAINS 未配置/为空）时的显式告警 -->
      <n-alert v-if="noDomainsConfigured" type="warning" :show-icon="false" class="rounded-2xl">
        后端没有返回可用域名——请检查 Worker 的 DOMAINS 环境变量配置
      </n-alert>

      <!-- ① 地址工坊 -->
      <div class="rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white dark:bg-zinc-900/60 shadow-xs p-5 space-y-4">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="text-base font-semibold text-zinc-900 dark:text-zinc-100">域名邮箱 · 全域接码</span>
            <span class="px-2 py-0.5 text-[10px] rounded-md font-mono bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/50">
              Catch-All
            </span>
          </div>
          <div class="flex items-center gap-3">
            <n-switch v-model:value="autoRefresh" size="small">
              <template #checked>30s 自动刷新</template>
              <template #unchecked>手动刷新</template>
            </n-switch>
            <n-button size="small" quaternary :loading="loading" @click="() => refreshAll()">刷新</n-button>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2.5">
          <n-input
            v-model:value="name"
            placeholder="邮箱名，如 shop001 / github"
            clearable
            class="w-56"
          >
            <template #prefix><span class="text-zinc-400 text-xs">✉️</span></template>
          </n-input>
          <n-button size="small" quaternary title="随机生成一个易记好用的前缀" @click="generateRandomPrefix">
            🎲 随机
          </n-button>
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

        <div v-if="fullAddress" class="flex items-center gap-3 flex-wrap pt-0.5">
          <div class="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700 text-sm font-mono text-zinc-800 dark:text-zinc-200">
            <span>{{ fullAddress }}</span>
            <button
              type="button"
              class="text-xs text-blue-500 hover:text-blue-600 cursor-pointer"
              title="复制完整地址"
              @click="copyAddress"
            >
              📋
            </button>
          </div>
          <n-checkbox v-model:checked="addressOnly" size="small">
            只看这个地址（关闭 = 接收该域名下全部邮件）
          </n-checkbox>
          <button
            type="button"
            class="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 underline cursor-pointer"
            @click="clearPrefix"
          >
            清空前缀
          </button>
        </div>
        <div v-else class="text-xs text-zinc-500 dark:text-zinc-400">
          💡 输入前缀并选择域名后可复制地址对外使用；不输入前缀时直接查看所选域名的全域邮件。
        </div>
      </div>

      <!-- ② 验证码聚合 -->
      <div
        v-if="codes.length || codesLoading"
        class="rounded-2xl border border-emerald-200/60 dark:border-emerald-800/40 bg-emerald-50/60 dark:bg-emerald-950/20 p-5 space-y-3"
      >
        <div class="flex items-center justify-between flex-wrap gap-2">
          <div class="flex items-center gap-2">
            <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            <div class="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
              近 {{ codeFreshnessMinutes < 60 ? `${codeFreshnessMinutes} 分钟` : (codeFreshnessMinutes === 60 ? '1 小时' : '24 小时') }}验证码
            </div>
            <n-spin v-if="codesLoading" :size="14" />
          </div>
          <div class="flex items-center gap-1.5 text-xs">
            <button
              v-for="opt in freshnessOptions"
              :key="opt.value"
              type="button"
              class="px-2.5 py-1 rounded-lg transition-colors cursor-pointer"
              :class="codeFreshnessMinutes === opt.value
                ? 'bg-emerald-600 text-white font-medium shadow-2xs'
                : 'text-emerald-700 dark:text-emerald-400 bg-white/70 dark:bg-zinc-900/60 hover:bg-emerald-100/70 border border-emerald-200/60 dark:border-emerald-800/40'"
              @click="codeFreshnessMinutes = opt.value"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>

        <div v-if="codes.length" class="grid gap-2 sm:grid-cols-2">
          <button
            v-for="(c, i) in codes"
            :key="i"
            type="button"
            class="text-left px-4 py-3 rounded-xl bg-white dark:bg-zinc-900/70 border border-emerald-200/70 dark:border-emerald-800/40 hover:border-emerald-400 dark:hover:border-emerald-500 transition-all cursor-pointer shadow-2xs hover:shadow-xs group"
            @click="copyCode(c.code)"
          >
            <div class="flex items-center justify-between gap-3">
              <span class="text-xl font-mono font-bold tracking-widest text-emerald-600 dark:text-emerald-400 group-hover:scale-105 transition-transform origin-left">
                {{ c.code }}
              </span>
              <span class="text-[10px] text-zinc-400 font-mono shrink-0">{{ fmtTime(c.received_at) }}</span>
            </div>
            <div class="text-xs text-zinc-500 dark:text-zinc-400 truncate mt-1">
              {{ c.from_addr }} · {{ c.subject }}
            </div>
          </button>
        </div>
        <div v-else-if="!codesLoading" class="text-xs text-emerald-600/70 dark:text-emerald-400/70 py-1">
          该时间窗口内暂未收到包含验证码的邮件
        </div>
      </div>

      <!-- ③ 邮件列表与筛选工具栏 -->
      <div class="space-y-3">
        <!-- 搜索与状态筛选栏 -->
        <div class="flex items-center justify-between flex-wrap gap-2.5 px-1">
          <div class="flex items-center gap-2 flex-wrap">
            <n-input
              v-model:value="searchQuery"
              placeholder="搜索主题、发件人或内容..."
              clearable
              size="small"
              class="w-60"
            >
              <template #prefix><span class="text-zinc-400 text-xs">🔍</span></template>
            </n-input>
            <div class="flex items-center rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-0.5 text-xs">
              <button
                type="button"
                class="px-2.5 py-1 rounded-md transition-colors cursor-pointer"
                :class="statusFilter === 'all' ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-medium' : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200'"
                @click="statusFilter = 'all'"
              >
                全部
              </button>
              <button
                type="button"
                class="px-2.5 py-1 rounded-md transition-colors cursor-pointer"
                :class="statusFilter === 'unread' ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-medium' : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200'"
                @click="statusFilter = 'unread'"
              >
                未读
              </button>
              <button
                type="button"
                class="px-2.5 py-1 rounded-md transition-colors cursor-pointer"
                :class="statusFilter === 'starred' ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-medium' : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200'"
                @click="statusFilter = 'starred'"
              >
                ⭐ 星标
              </button>
            </div>
          </div>

          <div class="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400 font-mono">
            <span>{{ addressOnly && fullAddress ? fullAddress : `@${domain}` }}</span>
            <span class="text-zinc-300 dark:text-zinc-600">·</span>
            <span>{{ emails.length }} 封</span>
          </div>
        </div>

        <!-- 列表容器 -->
        <div v-if="loading" class="py-16 text-center text-zinc-400">
          <span class="animate-spin text-xl">⏳</span>
        </div>
        <div v-else-if="listError" class="py-12 text-center text-sm text-rose-500">
          <div>{{ listError }}</div>
          <n-button size="small" class="mt-3" @click="() => refreshAll()">重试</n-button>
        </div>
        <n-empty
          v-else-if="!emails.length"
          description="该范围暂无邮件——将上面生成的地址填入注册页，邮件到达后秒级呈现"
          class="py-16"
        />
        <div
          v-else
          class="rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 divide-y divide-zinc-100 dark:divide-zinc-800/70 overflow-hidden bg-white dark:bg-zinc-900/60 shadow-xs"
        >
          <div
            v-for="row in emails"
            :key="row.id"
            role="button"
            tabindex="0"
            class="w-full text-left px-5 py-3.5 flex items-center gap-3.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors cursor-pointer group focus:outline-none focus:bg-zinc-50 dark:focus:bg-zinc-800/50"
            @click="openDetail(row.id)"
            @keydown.enter.self="openDetail(row.id)"
            @keydown.space.self.prevent="openDetail(row.id)"
          >
            <!-- 未读指示点（点击切换已读/未读） -->
            <button
              type="button"
              class="w-3 h-3 rounded-full shrink-0 transition-all cursor-pointer"
              :class="row.is_read ? 'bg-transparent border border-zinc-300 dark:border-zinc-700 hover:border-zinc-500' : 'bg-emerald-500 shadow-xs shadow-emerald-500/50'"
              :title="row.is_read ? '点击标记为未读' : '点击标记为已读'"
              @click="toggleRead(row, $event)"
            ></button>

            <!-- 星标快速切换按钮 -->
            <button
              type="button"
              class="text-sm shrink-0 cursor-pointer opacity-70 hover:opacity-100 transition-opacity"
              :class="row.is_starred ? 'text-amber-400' : 'text-zinc-300 dark:text-zinc-600 hover:text-amber-400'"
              :title="row.is_starred ? '已星标（永久保留正文）' : '点击加星标'"
              @click="toggleStar(row, $event)"
            >
              {{ row.is_starred ? '⭐' : '☆' }}
            </button>

            <!-- 邮件主题与地址信息 -->
            <div class="min-w-0 flex-1 space-y-1">
              <div class="flex items-baseline gap-2 flex-wrap">
                <span class="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                  {{ row.subject || '（无主题）' }}
                </span>
                <span v-if="hasAttachments(row)" class="text-xs text-zinc-400" title="包含附件">📎</span>
                <n-tag size="tiny" :bordered="false" class="shrink-0 font-mono">{{ row.account_id }}</n-tag>
              </div>

              <!-- 发信人与收信人（高亮显示 catch-all 目标收件地址并提供一键筛选） -->
              <div class="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400 flex-wrap">
                <span class="truncate max-w-[200px]" :title="'发件人：' + row.from_addr">{{ row.from_addr }}</span>
                <span class="text-zinc-300 dark:text-zinc-600 font-mono">→</span>
                <span
                  class="font-mono text-[11px] px-2 py-0.5 rounded-md bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-zinc-200/70 dark:border-zinc-700/70 inline-flex items-center gap-1.5"
                  :title="'实际收件地址：' + row.to_addr"
                >
                  <span class="truncate max-w-[220px]">{{ row.to_addr }}</span>
                  <button
                    v-if="!addressOnly || fullAddress !== row.to_addr"
                    type="button"
                    class="text-[10px] text-blue-500 hover:text-blue-600 dark:text-blue-400 font-sans cursor-pointer underline hover:no-underline"
                    title="只看这个收件地址"
                    @click.stop="filterByAddress(row.to_addr)"
                  >
                    筛选
                  </button>
                  <button
                    type="button"
                    class="text-[10px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 cursor-pointer"
                    title="复制此收件地址"
                    @click.stop="copyText(row.to_addr, '收件地址已复制')"
                  >
                    📋
                  </button>
                </span>
              </div>
            </div>

            <!-- 时间戳 -->
            <div class="text-xs text-zinc-400 shrink-0 font-mono">{{ fmtTime(row.received_at) }}</div>
          </div>
        </div>

        <!-- 游标分页：加载更多 -->
        <div v-if="nextCursor" class="text-center pt-2">
          <n-button size="small" quaternary :loading="loadingMore" @click="loadMore">
            加载更多
          </n-button>
        </div>
      </div>
    </template>
  </div>
</template>
