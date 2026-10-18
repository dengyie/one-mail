<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useMessage } from 'naive-ui'
import MailIcon from '../../components/ui/MailIcon.vue'
import WorkspaceEmpty from '../../components/ui/WorkspaceEmpty.vue'
import { useScopedI18n } from '../../i18n/app'
import { api } from '../../api'
import { getRouterPathWithLang } from '../../utils'

const { t: adminT, locale } = useScopedI18n('views.Admin')
const { t: workspaceT } = useScopedI18n('workspace')
const { t: unifiedT } = useScopedI18n('unified')
const message = useMessage()

const PAGE_SIZE = 20
const query = ref('')
const appliedQuery = ref('')
const emails = ref([])
const loading = ref(false)
const error = ref('')
const page = ref(1)
const cursor = ref(null)
const nextCursor = ref(null)
const hasMore = ref(false)
const degraded = ref([])
const cursorStack = ref([])
const downloadingKey = ref('')
let listController
let downloadController
let requestSequence = 0
let disposed = false

const normalizeAttachment = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const name = typeof value.name === 'string'
    ? value.name
    : typeof value.filename === 'string' ? value.filename : ''
  const mimeType = typeof value.mimeType === 'string'
    ? value.mimeType
    : typeof value.mime_type === 'string' ? value.mime_type : ''
  const id = typeof value.id === 'string' ? value.id : ''
  const size = Number(value.size)
  if (!id && !name && !mimeType) return null
  return {
    id,
    name: name || id || adminT('unnamedAttachment'),
    mimeType,
    size: Number.isSafeInteger(size) && size >= 0 ? size : 0,
    downloadable: value.downloadable === true,
  }
}

const parseAttachments = (value) => {
  if (!value) return []
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return Array.isArray(parsed) ? parsed.map(normalizeAttachment).filter(Boolean) : []
  } catch {
    return []
  }
}

const attachmentRows = computed(() => emails.value
  .map((email) => ({ ...email, attachments: parseAttachments(email.attachments_json) }))
  .filter((email) => email.attachments.length > 0))

const formatTime = (value) => {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp)) return ''
  return new Intl.DateTimeFormat(locale.value || 'zh', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp))
}

const formatSize = (value) => {
  const size = Number(value)
  if (!Number.isFinite(size) || size < 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

const filenameFromDisposition = (value) => {
  const encoded = String(value || '').match(/filename\*=(?:UTF-8'')?([^;]+)/i)?.[1]
  if (encoded) {
    try { return decodeURIComponent(encoded.replace(/^"|"$/g, '')) } catch { /* use metadata name */ }
  }
  return String(value || '').match(/filename="([^"]+)"/i)?.[1] || ''
}

const isCurrentRequest = (controller, sequence) =>
  !disposed && !controller.signal.aborted && sequence === requestSequence

const load = async () => {
  listController?.abort()
  const controller = new AbortController()
  listController = controller
  const sequence = ++requestSequence
  loading.value = true
  error.value = ''
  try {
    const result = await api.unified.listEmails({
      q: appliedQuery.value || undefined,
      has_attachments: 1,
      limit: PAGE_SIZE,
      cursor: cursor.value || undefined,
      with_count: 0,
    }, { signal: controller.signal })
    if (!isCurrentRequest(controller, sequence)) return
    emails.value = Array.isArray(result?.results) ? result.results : []
    nextCursor.value = typeof result?.next_cursor === 'string' ? result.next_cursor : null
    hasMore.value = Boolean(result?.has_more)
    degraded.value = Array.isArray(result?.degraded) ? result.degraded : []
  } catch (cause) {
    if (!isCurrentRequest(controller, sequence)) return
    if (cause?.name !== 'CanceledError' && cause?.name !== 'AbortError') {
      error.value = cause?.message || 'error'
      emails.value = []
      nextCursor.value = null
      hasMore.value = false
      degraded.value = []
    }
  } finally {
    if (isCurrentRequest(controller, sequence)) loading.value = false
  }
}

const resetAndLoad = () => {
  page.value = 1
  cursor.value = null
  cursorStack.value = []
  nextCursor.value = null
  hasMore.value = false
  degraded.value = []
  void load()
}

const applySearch = () => {
  appliedQuery.value = query.value.trim()
  resetAndLoad()
}

const clearSearch = () => {
  query.value = ''
  appliedQuery.value = ''
  resetAndLoad()
}

const nextPage = () => {
  if (loading.value || !hasMore.value || !nextCursor.value) return
  cursorStack.value.push(cursor.value)
  cursor.value = nextCursor.value
  page.value += 1
  void load()
}

const previousPage = () => {
  if (loading.value || page.value <= 1) return
  cursor.value = cursorStack.value.pop() || null
  page.value -= 1
  void load()
}

const downloadAttachment = async (email, attachment) => {
  if (!attachment.downloadable || !attachment.id || downloadingKey.value) return
  const key = `${email.id}:${attachment.id}`
  const controller = new AbortController()
  downloadController = controller
  downloadingKey.value = key
  try {
    const result = await api.unified.downloadAttachment(email.id, attachment.id, { signal: controller.signal })
    const url = URL.createObjectURL(result.blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filenameFromDisposition(result.headers?.['content-disposition']) || attachment.name || 'attachment'
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  } catch (cause) {
    if (cause?.name !== 'CanceledError' && cause?.name !== 'AbortError') {
      message.error(cause?.message || unifiedT('detail.downloadFailed'))
    }
  } finally {
    if (downloadingKey.value === key) downloadingKey.value = ''
    if (downloadController === controller) downloadController = undefined
  }
}

onMounted(load)
onBeforeUnmount(() => {
  disposed = true
  listController?.abort()
  downloadController?.abort()
  requestSequence += 1
})
</script>

<template>
  <div class="space-y-5">
    <form class="flex flex-wrap items-center gap-2" @submit.prevent="applySearch">
      <n-input
        v-model:value="query"
        class="min-w-[220px] flex-1"
        clearable
        :placeholder="unifiedT('list.searchPlaceholder')"
        :input-props="{ 'aria-label': unifiedT('list.searchPlaceholder') }"
        @clear="clearSearch"
      >
        <template #prefix><MailIcon name="search" :size="16" /></template>
      </n-input>
      <n-button attr-type="submit" type="primary" :loading="loading">
        {{ unifiedT('list.search') }}
      </n-button>
      <n-button :loading="loading" :aria-label="workspaceT('refresh')" @click="resetAndLoad">
        <template #icon><MailIcon name="refresh" :size="16" /></template>
        {{ workspaceT('refresh') }}
      </n-button>
    </form>

    <n-alert v-if="error" type="error" :show-icon="false">
      <div class="flex items-center justify-between gap-3">
        <span>{{ error }}</span>
        <n-button text size="small" @click="load">{{ workspaceT('retry') }}</n-button>
      </div>
    </n-alert>

    <n-alert v-if="degraded.length" type="warning" :show-icon="false">
      <div class="flex items-center justify-between gap-3">
        <span>{{ unifiedT('list.incompleteResults') }} ({{ degraded.join(', ') }})</span>
        <n-button text size="small" :loading="loading" @click="load">{{ unifiedT('list.retryDegraded') }}</n-button>
      </div>
    </n-alert>

    <div v-if="loading && !emails.length" class="workspace-panel p-6 space-y-4" aria-busy="true">
      <n-skeleton v-for="i in 4" :key="i" text :repeat="3" />
    </div>

    <WorkspaceEmpty
      v-else-if="!error && !attachmentRows.length"
      icon="paperclip"
      :title="unifiedT(appliedQuery ? 'list.emptyFiltered' : 'list.empty')"
      :description="adminT('attachmentsSubtitle')"
    >
      <n-button v-if="appliedQuery" @click="clearSearch">{{ workspaceT('clearFilters') }}</n-button>
    </WorkspaceEmpty>

    <div v-else-if="attachmentRows.length" class="space-y-3" :aria-busy="loading">
      <article v-for="email in attachmentRows" :key="email.id" class="workspace-panel p-4 sm:p-5 space-y-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <RouterLink
              class="text-base font-semibold text-slate-900 dark:text-white hover:text-emerald-600 dark:hover:text-emerald-400 break-words"
              :to="{ path: getRouterPathWithLang(`/unified/${encodeURIComponent(email.id)}`, locale), query: { from: getRouterPathWithLang('/admin/attachments', locale) } }"
            >
              {{ email.subject || unifiedT('list.noSubject') }}
            </RouterLink>
            <div class="mt-1 text-xs text-slate-500 dark:text-slate-400 break-all">
              {{ email.from_addr }} → {{ email.to_addr }} · {{ formatTime(email.received_at) }}
            </div>
          </div>
          <n-tag size="small" :bordered="false" type="info">
            <MailIcon name="paperclip" :size="13" />
            {{ unifiedT('detail.attachments') }} · {{ email.attachments.length }}
          </n-tag>
        </div>

        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div v-for="attachment in email.attachments" :key="attachment.id || attachment.name" class="flex min-w-0 items-center gap-3 rounded-xl border border-slate-200/80 bg-slate-50/70 p-3 dark:border-slate-800/80 dark:bg-slate-900/50">
            <MailIcon name="paperclip" :size="18" class="shrink-0 text-slate-400" />
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium text-slate-800 dark:text-slate-100" :title="attachment.name">{{ attachment.name }}</div>
              <div class="text-xs text-slate-500 dark:text-slate-400">{{ formatSize(attachment.size) }}<span v-if="attachment.mimeType"> · {{ attachment.mimeType }}</span></div>
            </div>
            <n-button
              v-if="attachment.downloadable"
              size="small"
              :loading="downloadingKey === `${email.id}:${attachment.id}`"
              :disabled="Boolean(downloadingKey)"
              :aria-label="`${unifiedT('detail.download')} ${attachment.name}`"
              @click="downloadAttachment(email, attachment)"
            >
              <template #icon><MailIcon name="download" :size="15" /></template>
              {{ unifiedT('detail.download') }}
            </n-button>
            <span v-else class="shrink-0 text-xs text-slate-400" :title="unifiedT('detail.attachmentNoDownload')">{{ unifiedT('detail.metadataOnly') }}</span>
          </div>
        </div>
      </article>
    </div>

    <div v-if="page > 1 || hasMore" class="flex items-center justify-between gap-3">
      <n-button size="small" :disabled="loading || page <= 1" @click="previousPage">
        <template #icon><MailIcon name="arrow-left" :size="15" /></template>
        {{ unifiedT('list.prev') }}
      </n-button>
      <span class="text-xs text-slate-500" aria-live="polite">{{ workspaceT('pageNumber', { page }) }}</span>
      <n-button size="small" :disabled="loading || !hasMore || !nextCursor || degraded.length > 0" @click="nextPage">
        {{ unifiedT('list.next') }}
        <template #icon><MailIcon name="arrow-right" :size="15" /></template>
      </n-button>
    </div>
  </div>
</template>
