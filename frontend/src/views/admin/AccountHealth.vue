<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed } from 'vue'
import { useScopedI18n } from '@/i18n/app'
import { api } from '../../api'

// 聚合器邮箱健康状态页（2026-11 QQ 断信 6 天无人发现的事故沉淀）。
// 数据源 GET /admin/account_health：per-account 快照 + daemon 心跳，
// Worker 侧已派生 fresh/breaker_open，前端只做分级渲染 + 15s 轮询。
const controller = new AbortController()
const { t } = useScopedI18n('views.admin.AccountHealth')

const AUTO_REFRESH_MS = 15000

type AccountHealth = {
    account_id: string
    label: string | null
    source: string | null
    username: string | null
    user_managed: number
    last_sync_at: number | null
    last_error: string | null
    error_kind: string | null
    fail_count: number
    skip_until: number | null
    idle_alive: number | null
    poll_interval_seconds: number | null
    updated_at: number
    fresh: boolean
    breaker_open: boolean
}

type Daemon = {
    started_at: number | null
    accounts_count: number | null
    socks5_egress: string | null
    aggregator_version: string | null
    updated_at: number
    stale: boolean
    age_ms: number
} | null

type HealthReport = {
    accounts: AccountHealth[]
    daemon: Daemon
    generated_at: number
    warning?: string
}

const report = ref<HealthReport | null>(null)
const loading = ref(false)
const errorMessage = ref('')
const nowTs = ref(Date.now())
const refreshTimer = ref<number | null>(null)

const isHealthReport = (value: unknown): value is HealthReport => {
    if (!value || typeof value !== 'object') return false
    const data = value as Record<string, unknown>
    if (!Array.isArray(data.accounts)) return false
    return data.accounts.every((entry: unknown) => {
        if (!entry || typeof entry !== 'object') return false
        return typeof (entry as Record<string, unknown>).account_id === 'string'
    })
}

async function loadHealth(): Promise<void> {
    if (loading.value || controller.signal.aborted) return
    loading.value = true
    errorMessage.value = ''
    try {
        const data: unknown = await api.fetch('/admin/account_health', { signal: controller.signal })
        if (controller.signal.aborted) return
        if (!isHealthReport(data)) throw new Error(t('invalidReport'))
        report.value = data
        nowTs.value = Date.now()
    } catch (error) {
        if (controller.signal.aborted) return
        if (!report.value) report.value = null
        errorMessage.value = error instanceof Error ? error.message : String(error)
    } finally {
        loading.value = false
    }
}

onMounted(() => {
    loadHealth()
    refreshTimer.value = window.setInterval(loadHealth, AUTO_REFRESH_MS)
})
onBeforeUnmount(() => {
    controller.abort()
    if (refreshTimer.value !== null) window.clearInterval(refreshTimer.value)
})

// 状态分级：🟢 ok / 🟡 warning / 🔴 error / ⚪ stale（daemon 失联时全站降级）
const levelOf = (account: AccountHealth): 'ok' | 'warning' | 'error' | 'stale' => {
    if (!report.value?.daemon || report.value.daemon.stale) return 'stale'
    if (!account.fresh) return 'stale'
    if (account.last_error) return 'error'
    if (account.breaker_open || account.fail_count > 0) return 'warning'
    return 'ok'
}

// i18n 键名是 PascalCase（levelOk/levelWarning/...）；写成纯函数避免模板里
// 对对象误调 charAt 一类的字符串方法（首版曾因模板内联表达式整页崩溃）。
const levelLabelKey = (account: AccountHealth): string => {
    const level = levelOf(account)
    return 'level' + level.charAt(0).toUpperCase() + level.slice(1)
}

const tagTypeOf = (level: string) => (
    level === 'ok' ? 'success' : level === 'warning' ? 'warning' : level === 'error' ? 'error' : 'default'
)

const ERROR_KIND_LABEL_KEYS: Record<string, string> = {
    auth: 'kindAuth',
    conn: 'kindConn',
    proxy: 'kindProxy',
    quota: 'kindQuota',
    ratelimit: 'kindRatelimit',
    persist: 'kindPersist',
    policy: 'kindPolicy',
    folder: 'kindFolder',
    unknown: 'kindUnknown',
}

const errorKindLabel = (account: AccountHealth): string => {
    const kind = account.error_kind || (account.last_error ? 'unknown' : '')
    return kind && ERROR_KIND_LABEL_KEYS[kind] ? t(ERROR_KIND_LABEL_KEYS[kind]) : ''
}

const formatTime = (epochMs: number | null): string => {
    if (!epochMs) return t('never')
    return new Date(epochMs).toLocaleString()
}

const formatAge = (epochMs: number | null): string => {
    if (!epochMs) return t('never')
    const seconds = Math.max(0, Math.floor((nowTs.value - epochMs) / 1000))
    if (seconds < 60) return t('secondsAgo', { count: seconds })
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return t('minutesAgo', { count: minutes })
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return t('hoursAgo', { count: hours })
    return t('daysAgo', { count: Math.floor(hours / 24) })
}

const breakerUntil = (account: AccountHealth): string => {
    if (!account.breaker_open) return ''
    const target = new Date(account.skip_until ?? 0)
    return `${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`
}

const daemonAlive = computed(() => !!report.value?.daemon && !report.value.daemon.stale)
const errorCount = computed(() => (report.value?.accounts ?? []).filter((a) => levelOf(a) === 'error').length)
const warningCount = computed(() => (report.value?.accounts ?? []).filter((a) => ['warning', 'stale'].includes(levelOf(a))).length)
const okCount = computed(() => (report.value?.accounts ?? []).filter((a) => levelOf(a) === 'ok').length)
</script>

<template>
    <div class="space-y-4">
        <div class="flex items-center justify-between">
            <div>
                <p class="text-sm font-semibold text-slate-900 dark:text-white">{{ t('sectionTitle') }}</p>
                <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{{ t('sectionHint') }}</p>
            </div>
            <n-button quaternary size="tiny" :loading="loading" :disabled="loading" @click="loadHealth()">
                {{ t('refresh') }}
            </n-button>
        </div>

        <template v-if="errorMessage">
            <n-alert type="error" :show-icon="false" :bordered="false">
                <p>{{ errorMessage }}</p>
            </n-alert>
        </template>

        <p v-else-if="!report" role="status" class="text-sm text-slate-500 dark:text-slate-400">
            {{ t('loading') }}
        </p>

        <template v-else>
            <!-- daemon 失联：整页顶部红条 -->
            <n-alert v-if="!daemonAlive" type="error" :show-icon="false" :bordered="false">
                <p class="font-semibold">{{ t('daemonStale') }}</p>
                <p v-if="report.daemon" class="text-xs mt-1">
                    {{ t('lastHeartbeat', { time: formatTime(report.daemon.updated_at), age: formatAge(report.daemon.updated_at) }) }}
                </p>
                <p v-else class="text-xs mt-1">{{ t('noHeartbeat') }}</p>
            </n-alert>
            <n-alert v-else-if="report.warning" type="warning" :show-icon="false" :bordered="false">
                <p>{{ report.warning }}</p>
            </n-alert>

            <!-- 聚合横幅 -->
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div class="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/60">
                    <p class="text-xs text-slate-500 dark:text-slate-400">{{ t('daemonStatus') }}</p>
                    <n-tag :type="daemonAlive ? 'success' : 'error'" size="small" :bordered="false" class="mt-1">
                        {{ daemonAlive ? t('daemonAlive') : t('daemonDown') }}
                    </n-tag>
                    <p v-if="report.daemon && daemonAlive" class="text-xs text-slate-400 mt-1">
                        {{ t('heartbeatAge', { age: formatAge(report.daemon.updated_at) }) }}
                    </p>
                </div>
                <div class="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/60">
                    <p class="text-xs text-slate-500 dark:text-slate-400">{{ t('socks5Egress') }}</p>
                    <p class="text-sm font-mono text-slate-900 dark:text-white mt-1 break-all">
                        {{ report.daemon?.socks5_egress || t('unknown') }}
                    </p>
                </div>
                <div class="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/60">
                    <p class="text-xs text-slate-500 dark:text-slate-400">{{ t('accountTotals') }}</p>
                    <p class="text-sm text-slate-900 dark:text-white mt-1">
                        {{ t('totalsBreakdown', { total: report.accounts.length, ok: okCount, warn: warningCount, err: errorCount }) }}
                    </p>
                </div>
                <div class="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/60">
                    <p class="text-xs text-slate-500 dark:text-slate-400">{{ t('aggregatorVersion') }}</p>
                    <p class="text-sm font-mono text-slate-900 dark:text-white mt-1">
                        {{ report.daemon?.aggregator_version || t('unknown') }}
                    </p>
                </div>
            </div>

            <p v-if="report.accounts.length === 0" class="text-sm text-slate-500 dark:text-slate-400">
                {{ t('noAccounts') }}
            </p>

            <!-- 账号卡片列表 -->
            <div v-else class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div v-for="account in report.accounts" :key="account.account_id"
                     class="p-5 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/60 space-y-2">
                    <div class="flex items-center justify-between gap-2">
                        <p class="text-sm font-bold text-slate-900 dark:text-white font-mono truncate">
                            {{ account.label || account.account_id }}
                        </p>
                        <n-tag :type="tagTypeOf(levelOf(account))" size="small" :bordered="false">
                            {{ t(levelLabelKey(account)) }}
                        </n-tag>
                    </div>
                    <p class="text-xs text-slate-500 dark:text-slate-400 break-all">
                        {{ account.username || '—' }}
                        <n-tag v-if="account.user_managed" size="tiny" :bordered="false" class="ml-1">{{ t('userManaged') }}</n-tag>
                    </p>
                    <p class="text-xs text-slate-400 dark:text-slate-500 font-mono">
                        {{ t('sourceLabel', { source: account.source || '—' }) }}
                        <span v-if="account.poll_interval_seconds"> · {{ t('pollEvery', { seconds: account.poll_interval_seconds }) }}</span>
                    </p>
                    <p class="text-xs text-slate-500 dark:text-slate-400">
                        {{ t('lastSync', { time: formatAge(account.last_sync_at) }) }}
                        <span v-if="account.idle_alive === 1" class="ml-1">· IDLE ✓</span>
                        <span v-else-if="account.idle_alive === 0" class="ml-1">· IDLE ✗</span>
                    </p>
                    <p v-if="account.breaker_open" class="text-xs text-amber-600 dark:text-amber-400">
                        {{ t('breakerOpen', { until: breakerUntil(account), fails: account.fail_count }) }}
                    </p>
                    <p v-else-if="account.fail_count > 0" class="text-xs text-slate-400">
                        {{ t('failCount', { count: account.fail_count }) }}
                    </p>
                    <p v-if="account.last_error" class="text-xs text-red-600 dark:text-red-400 break-all">
                        <span v-if="errorKindLabel(account)" class="font-semibold">[{{ errorKindLabel(account) }}]</span>
                        {{ account.last_error }}
                    </p>
                </div>
            </div>
        </template>
    </div>
</template>
