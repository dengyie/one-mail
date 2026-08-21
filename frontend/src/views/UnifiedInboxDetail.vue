<template>
  <div class="unified-detail max-w-4xl mx-auto px-4 py-6 text-left">
    <div v-if="loading" class="py-20 text-center text-zinc-400">{{ t('list.loading') }}</div>

    <n-empty v-else-if="error && !email" :description="error" class="py-20">
      <template #extra>
        <n-button size="small" @click="router.push('/unified')">{{ t('detail.back') }}</n-button>
      </template>
    </n-empty>

    <template v-else-if="email">
      <div class="mb-4">
        <n-button size="small" quaternary @click="router.push('/unified')">
          <template #icon><n-icon><ArrowBackRound /></n-icon></template>
          {{ t('detail.back') }}
        </n-button>
      </div>

      <div class="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 overflow-hidden">
        <!-- 头：主题 + 操作 -->
        <div class="px-5 py-4 border-b border-zinc-100 dark:border-zinc-800/70 flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h1 class="text-lg font-semibold text-zinc-900 dark:text-zinc-100 break-words">
              {{ email.subject || t('list.noSubject') }}
            </h1>
            <div class="flex flex-wrap items-center gap-2 mt-2">
              <n-tag size="small" :bordered="false" type="info">{{ email.source }}</n-tag>
              <n-tag v-if="email.account_id" size="small" :bordered="false">{{ email.account_id }}</n-tag>
              <n-tag v-if="!email.is_read" size="small" type="warning" :bordered="false">{{ t('list.unread') }}</n-tag>
            </div>
          </div>
          <n-button
            v-if="!email.is_read"
            size="small"
            type="primary"
            :loading="marking"
            @click="markRead"
          >
            {{ t('detail.markRead') }}
          </n-button>
          <n-tag v-else size="small" type="success" :bordered="false">✓</n-tag>
        </div>

        <!-- 元信息 -->
        <div class="px-5 py-3 border-b border-zinc-100 dark:border-zinc-800/70 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1.5 text-sm">
          <div class="flex gap-2">
            <span class="text-zinc-400 shrink-0 w-16">{{ t('detail.from') }}</span>
            <span class="text-zinc-800 dark:text-zinc-200 break-all">{{ email.from_addr }}</span>
          </div>
          <div class="flex gap-2">
            <span class="text-zinc-400 shrink-0 w-16">{{ t('detail.to') }}</span>
            <span class="text-zinc-800 dark:text-zinc-200 break-all">{{ email.to_addr }}</span>
          </div>
          <div class="flex gap-2">
            <span class="text-zinc-400 shrink-0 w-16">{{ t('detail.receivedAt') }}</span>
            <span class="text-zinc-800 dark:text-zinc-200">{{ fmtTime(email.received_at) }}</span>
          </div>
          <div v-if="email.raw_ref" class="flex gap-2">
            <span class="text-zinc-400 shrink-0 w-16">{{ t('detail.rawRef') }}</span>
            <span class="text-zinc-800 dark:text-zinc-200 font-mono text-xs break-all">{{ email.raw_ref }}</span>
          </div>
        </div>

        <!-- 正文 -->
        <div class="px-5 py-4">
          <pre
            v-if="displayBody"
            class="whitespace-pre-wrap break-words font-sans text-[15px] leading-relaxed text-zinc-800 dark:text-zinc-200"
          >{{ displayBody }}</pre>
          <div v-else class="text-sm text-zinc-400 py-6 text-center">{{ t('detail.noBody') }}</div>
        </div>

        <!-- 附件 -->
        <div v-if="attachments.length" class="px-5 py-3 border-t border-zinc-100 dark:border-zinc-800/70">
          <div class="text-xs text-zinc-500 mb-2">{{ t('detail.attachments') }}</div>
          <div class="flex flex-wrap gap-2">
            <div
              v-for="(att, i) in attachments"
              :key="i"
              class="flex items-center gap-2 text-xs bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 rounded-lg px-2.5 py-1.5"
            >
              <span>📎</span>
              <span class="max-w-[200px] truncate">{{ att.filename || att.name || att.id || ('attachment-' + (i + 1)) }}</span>
              <span v-if="att.size" class="text-zinc-400">({{ fmtSize(att.size) }})</span>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowBackRound } from '@vicons/material'
import { useScopedI18n } from '../i18n/app'
import { api } from '../api'

const { t } = useScopedI18n('unified')
const route = useRoute()
const router = useRouter()
const message = useMessage()

const email = ref(null)
const loading = ref(true)
const error = ref('')
const marking = ref(false)

const load = async () => {
  loading.value = true
  error.value = ''
  email.value = null
  try {
    email.value = await api.unified.getEmail(route.params.id)
  } catch (e) {
    error.value = e.message || 'error'
  } finally {
    loading.value = false
  }
}
onMounted(load)

// 正文：优先纯文本；仅有 html_body 时做最小转纯文本（绝不用 v-html 注入）
const stripHtml = (html) =>
  String(html || '')
    .replace(/<(br\s*\/?|p|div|\/p|\/div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

const displayBody = computed(() => {
  if (email.value?.text_body) return email.value.text_body
  if (email.value?.html_body) return stripHtml(email.value.html_body)
  return ''
})

const attachments = computed(() => {
  const raw = email.value?.attachments_json
  if (!raw) return []
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
})

const markRead = async () => {
  if (email.value.is_read) return
  marking.value = true
  try {
    await api.unified.markRead(email.value.id)
    email.value.is_read = 1
    message.success(t('detail.markRead'))
  } catch (e) {
    message.error(e.message || 'error')
  } finally {
    marking.value = false
  }
}

const fmtTime = (ms) => {
  if (!ms) return ''
  const d = new Date(Number(ms))
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
}

const fmtSize = (bytes) => {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
</script>
