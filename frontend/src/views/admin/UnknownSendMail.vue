<script setup>
import { h, onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton, NPopconfirm, useMessage } from 'naive-ui'
import { useScopedI18n } from '@/i18n/app'
import { api } from '../../api'
import { utcToLocalDate } from '../../utils'
import { useGlobalState } from '../../store'

const AUTO_REFRESH_MS = 15000

const message = useMessage()
const { t } = useScopedI18n('views.admin.UnknownSendMail')
const { useUTCDate } = useGlobalState()

const data = ref([])
const count = ref(0)
const loading = ref(false)
let autoRefreshTimer = null
let componentDisposed = false
let fetchPending = false

const formatTime = (value) => {
  if (!value) return '—'
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  return utcToLocalDate(new Date(ms).toISOString().replace('T', ' ').slice(0, 19), useUTCDate.value)
}

const fetchData = async ({ background = false } = {}) => {
  if (fetchPending || componentDisposed) return
  fetchPending = true
  if (!background) loading.value = true
  try {
    const payload = await api.fetch('/admin/send_mail/unknown?limit=100')
    if (componentDisposed) return
    data.value = Array.isArray(payload?.results) ? payload.results : []
    count.value = Number(payload?.count) || data.value.length
  } catch (error) {
    if (!background) {
      message.error(error.message || 'error')
    }
  } finally {
    fetchPending = false
    if (!background) loading.value = false
  }
}

const resolveRow = async (row, outcome) => {
  try {
    await api.fetch(`/admin/send_mail/unknown/${row.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ outcome }),
    })
    message.success(t('resolved'))
    await fetchData()
  } catch (error) {
    message.error(error.message || 'error')
  }
}

const columns = [
  { title: t('id'), key: 'id', ellipsis: { tooltip: true } },
  { title: t('sender'), key: 'sender_address' },
  { title: t('balanceReserved'), key: 'balance_reserved' },
  {
    title: t('updatedAt'),
    key: 'updated_at',
    render(row) {
      return formatTime(row.updated_at)
    },
  },
  {
    title: t('expiresAt'),
    key: 'expires_at',
    render(row) {
      return formatTime(row.expires_at)
    },
  },
  {
    title: t('actions'),
    key: 'actions',
    render(row) {
      return h('div', { class: 'flex flex-wrap gap-2' }, [
        h(NPopconfirm, {
          onPositiveClick: () => resolveRow(row, 'sent'),
        }, {
          trigger: () => h(NButton, { size: 'small', type: 'success', tertiary: true }, { default: () => t('markSent') }),
          default: () => t('markSentTip'),
        }),
        h(NPopconfirm, {
          onPositiveClick: () => resolveRow(row, 'rejected'),
        }, {
          trigger: () => h(NButton, { size: 'small', type: 'error', tertiary: true }, { default: () => t('markRejected') }),
          default: () => t('markRejectedTip'),
        }),
      ])
    },
  },
]

const autoRefreshList = () => {
  if (componentDisposed) return
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
  void fetchData({ background: true })
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

onMounted(async () => {
  await fetchData()
  if (componentDisposed) return
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }
  startAutoRefresh()
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
    <div class="flex items-center justify-between gap-2 flex-wrap">
      <p class="text-xs text-slate-500 dark:text-slate-400">
        {{ t('count', { n: count }) }}
      </p>
      <n-button size="small" tertiary :loading="loading" @click="fetchData()">
        {{ t('refresh') }}
      </n-button>
    </div>
    <n-data-table
      :columns="columns"
      :data="data"
      :loading="loading"
      :bordered="false"
      :pagination="false"
    />
    <n-result v-if="!loading && data.length === 0" status="info" :title="t('empty')" />
  </div>
</template>
