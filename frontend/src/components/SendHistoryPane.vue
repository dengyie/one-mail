<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useScopedI18n } from '@/i18n/app'
import SendBox from './SendBox.vue'

const props = defineProps({
  endpoint: {
    type: String,
    required: true,
  },
  source: {
    type: String,
    default: '',
  },
  address: {
    type: String,
    default: '',
  },
  enableUserDeleteEmail: {
    type: Boolean,
    default: false,
  },
  deleteMail: {
    type: Function,
    default: null,
  },
  collapseOtp: {
    type: Boolean,
    default: false,
  },
  showFrom: {
    type: Boolean,
    default: false,
  },
  emptyDescription: {
    type: String,
    default: '',
  },
  refreshKey: {
    type: Number,
    default: 0,
  },
  autoRefresh: {
    type: Boolean,
    default: false,
  },
})

const { t } = useScopedI18n('components.SendHistory')

const AUTO_REFRESH_MS = 15000

const q = ref('')
const dateRange = ref(null)
const channelFilter = ref('')
const queryVersion = ref(0)
const quietRefreshKey = ref(0)
let autoRefreshTimer = null
let componentDisposed = false
let backgroundRefreshPending = false
let newestSeenKey = null

const channelOptions = computed(() => [
  { label: t('channelAll'), value: '' },
  { label: t('channelResend'), value: 'resend' },
  { label: t('channelSmtp'), value: 'smtp' },
  { label: t('channelBinding'), value: 'binding' },
  { label: t('channelVerifiedBinding'), value: 'verified_binding' },
])

const toEpochSeconds = (value) => {
  if (!value) return ''
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) return ''
  return String(Math.floor(time / 1000))
}

const buildListParams = ({ limit, offset, withCount = true }) => {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  params.set('offset', String(offset))
  // 服务端总数改为显式 opt-in（不传就不算），这里必须显式带上，不能依赖默认值。
  params.set('with_count', withCount ? '1' : '0')
  if (props.source) params.set('source', props.source)
  if (props.address) params.set('address', props.address)
  if (channelFilter.value) params.set('channel', channelFilter.value)
  if (q.value.trim()) params.set('q', q.value.trim())
  const from = toEpochSeconds(dateRange.value?.[0])
  const to = toEpochSeconds(dateRange.value?.[1])
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  return params
}

const fetchMailData = async (limit, offset) => {
  const { api } = await import('../api')
  const payload = await api.fetch(`${props.endpoint}?${buildListParams({ limit, offset, withCount: true }).toString()}`)
  const results = Array.isArray(payload?.results) ? payload.results : []
  if (offset === 0) {
    newestSeenKey = results[0] ? sendboxSortKey(results[0]) : ''
  }
  return {
    results,
    count: payload?.count,
  }
}

const sendboxSortKey = (row) => String(row?.id ?? '')

const probeNewestKey = async () => {
  const { api } = await import('../api')
  const payload = await api.fetch(`${props.endpoint}?${buildListParams({ limit: 1, offset: 0, withCount: false }).toString()}`)
  const top = Array.isArray(payload?.results) ? payload.results[0] : null
  return top ? sendboxSortKey(top) : ''
}

const applyFilters = () => {
  newestSeenKey = null
  queryVersion.value += 1
}

const autoRefreshList = () => {
  if (!props.autoRefresh || componentDisposed) return
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
  if (backgroundRefreshPending) return
  backgroundRefreshPending = true
  void (async () => {
    try {
      const newestKey = await probeNewestKey()
      if (componentDisposed) return
      if (newestSeenKey === null) {
        newestSeenKey = newestKey
        return
      }
      if (newestKey !== newestSeenKey) {
        newestSeenKey = newestKey
        quietRefreshKey.value += 1
      }
    } catch {
      // Keep the current list on a transient probe failure.
    } finally {
      backgroundRefreshPending = false
    }
  })()
}

const startAutoRefresh = () => {
  if (autoRefreshTimer != null || typeof window === 'undefined' || componentDisposed) return
  autoRefreshTimer = window.setInterval(autoRefreshList, AUTO_REFRESH_MS)
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

watch(
  () => [props.source, props.address, props.refreshKey],
  () => {
    newestSeenKey = null
    queryVersion.value += 1
  },
)

watch(() => props.autoRefresh, (enabled) => {
  if (enabled) startAutoRefresh()
  else stopAutoRefresh()
})

onMounted(() => {
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }
  if (props.autoRefresh) startAutoRefresh()
})

onBeforeUnmount(() => {
  componentDisposed = true
  stopAutoRefresh()
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleVisibilityChange)
  }
})
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-center gap-2 bg-slate-50/70 dark:bg-slate-900/40 p-3 rounded-2xl border border-slate-200/70 dark:border-slate-800/70">
      <n-input
        v-model:value="q"
        :placeholder="t('searchPlaceholder')"
        clearable
        size="small"
        style="max-width: 240px"
        @keyup.enter="applyFilters"
      />
      <n-date-picker
        v-model:value="dateRange"
        type="datetimerange"
        clearable
        size="small"
        :start-placeholder="t('fromTime')"
        :end-placeholder="t('toTime')"
        @update:value="applyFilters"
      />
      <n-select
        v-model:value="channelFilter"
        :options="channelOptions"
        size="small"
        style="width: 160px"
        @update:value="applyFilters"
      />
      <n-button size="small" type="primary" ghost @click="applyFilters">
        {{ t('search') }}
      </n-button>
    </div>
    <SendBox
      :key="`${endpoint}-${source}-${address}-${refreshKey}-${queryVersion}`"
      :fetch-mail-data="fetchMailData"
      :enable-user-delete-email="enableUserDeleteEmail"
      :delete-mail="deleteMail"
      :show-e-mail-from="showFrom"
      :collapse-otp="collapseOtp"
      :empty-description="emptyDescription"
      :quiet-refresh-key="quietRefreshKey"
    />
  </div>
</template>
