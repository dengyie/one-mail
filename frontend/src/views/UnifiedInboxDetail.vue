<template>
  <div class="unified-detail max-w-4xl mx-auto px-4 py-6 text-left space-y-4">
    <div v-if="loading" class="py-24 text-center text-zinc-400 flex flex-col items-center gap-2">
      <span class="animate-spin text-2xl">⏳</span>
      <span>{{ t('list.loading') }}</span>
    </div>

    <n-alert v-else-if="!hasAccess" type="warning" :show-icon="false" class="mb-4 rounded-2xl">
      <div class="flex items-center justify-between gap-3">
        <span>{{ t('auth.loginRequired') }}</span>
        <n-button size="small" type="primary" @click="router.push('/user')">{{ t('auth.login') }}</n-button>
      </div>
    </n-alert>

    <n-empty v-else-if="error && !email" :description="error" class="py-20">
      <template #extra>
        <n-button size="small" @click="router.push('/unified')">{{ t('detail.back') }}</n-button>
      </template>
    </n-empty>

    <template v-else-if="email">
      <div class="flex items-center justify-between">
        <n-button size="small" quaternary @click="router.push('/unified')">
          <template #icon><n-icon><ArrowBackRound /></n-icon></template>
          {{ t('detail.back') }}
        </n-button>

        <div class="flex items-center gap-2">
          <n-button size="small" quaternary :loading="loading" :aria-label="t('detail.refresh')" @click="load">
            <template #icon><n-icon><RefreshRound /></n-icon></template>
            {{ t('detail.refresh') }}
          </n-button>
          <button
            type="button"
            @click="showAiPanel = !showAiPanel; if (showAiPanel && !aiAnalysisText) generateAiAnalysis();"
            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800/50 hover:bg-purple-100 dark:hover:bg-purple-900/50 transition-all cursor-pointer shadow-xs"
          >
            <span>✨</span>
            <span>{{ showAiPanel ? '关闭 AI 分析' : 'AI 智能解析' }}</span>
          </button>

          <n-button
            size="small"
            quaternary
            :loading="starring"
            :type="email.is_starred ? 'warning' : 'default'"
            @click="toggleStar"
            :title="email.is_starred ? '取消星标（将参与 30 天自动清理）' : '星标邮件（永久保留正文，不被自动清理）'"
          >
            <span>{{ email.is_starred ? '⭐ 已星标' : '☆ 设为星标' }}</span>
          </n-button>

          <n-button
            v-if="!email.is_read"
            size="small"
            type="primary"
            :loading="marking"
            @click="markRead"
          >
            {{ t('detail.markRead') }}
          </n-button>
          <n-tag v-else size="small" type="success" :bordered="false">✓ 已读</n-tag>
        </div>
      </div>

      <!-- AI 智能分析卡片 -->
      <div
        v-if="showAiPanel"
        class="rounded-2xl border border-purple-200/80 dark:border-purple-800/60 bg-gradient-to-b from-purple-50/40 to-white dark:from-purple-950/20 dark:to-zinc-900/70 p-4 shadow-xs space-y-3"
      >
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="flex items-center justify-center w-6 h-6 rounded-lg bg-purple-500/20 text-purple-600 dark:text-purple-400 text-xs">
              ✨
            </span>
            <span class="text-xs font-semibold text-purple-900 dark:text-purple-200">
              AI 智能邮件摘要
            </span>
          </div>
        </div>

        <ThinkingBlock :is-thinking="aiThinking" :duration-seconds="aiDuration" />

        <div v-if="aiAnalysisText" class="p-3.5 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200/80 dark:border-zinc-800">
          <StreamMarkdown :content="aiAnalysisText" />
          <MessageActionToolbar :content="aiAnalysisText" role="assistant" @retry="generateAiAnalysis" />
        </div>
      </div>

      <div class="rounded-2xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white dark:bg-zinc-900/60 overflow-hidden shadow-xs">
        <!-- 头：主题 + 标签 -->
        <div class="px-5 py-4 border-b border-zinc-100 dark:border-zinc-800/70 space-y-2">
          <h1 class="text-lg font-bold text-zinc-900 dark:text-zinc-100 break-words">
            {{ email.subject || t('list.noSubject') }}
          </h1>
          <div class="flex flex-wrap items-center gap-2">
            <n-tag v-if="email.is_starred" size="small" type="warning" :bordered="false">⭐ 已星标保护</n-tag>
            <n-tag size="small" :bordered="false" type="info" class="font-mono">{{ email.source }}</n-tag>
            <n-tag v-if="email.account_id" size="small" :bordered="false" class="font-mono">{{ email.account_id }}</n-tag>
            <n-tag v-if="!email.is_read" size="small" type="warning" :bordered="false">{{ t('list.unread') }}</n-tag>
          </div>
        </div>

        <!-- 元信息 -->
        <div class="px-5 py-3 border-b border-zinc-100 dark:border-zinc-800/70 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2 text-xs">
          <div class="flex gap-2">
            <span class="text-zinc-400 shrink-0 w-16">{{ t('detail.from') }}</span>
            <span class="text-zinc-800 dark:text-zinc-200 font-mono break-all">{{ email.from_addr }}</span>
          </div>
          <div class="flex gap-2">
            <span class="text-zinc-400 shrink-0 w-16">{{ t('detail.to') }}</span>
            <span class="text-zinc-800 dark:text-zinc-200 font-mono break-all">{{ email.to_addr }}</span>
          </div>
          <div class="flex gap-2">
            <span class="text-zinc-400 shrink-0 w-16">{{ t('detail.receivedAt') }}</span>
            <span class="text-zinc-800 dark:text-zinc-200 font-mono">{{ fmtTime(email.received_at) }}</span>
          </div>
          <div v-if="email.raw_ref" class="flex gap-2">
            <span class="text-zinc-400 shrink-0 w-16">{{ t('detail.rawRef') }}</span>
            <span class="text-zinc-800 dark:text-zinc-200 font-mono break-all">{{ email.raw_ref }}</span>
          </div>
        </div>

        <!-- 正文：HTML 统一经过与主收件箱相同的安全管线；无 HTML 时才降级为纯文本。 -->
        <div class="px-5 py-4">
          <div v-if="htmlBody" class="mail-html-body prose prose-sm max-w-none dark:prose-invert" v-html="htmlBody"></div>
          <pre
            v-else-if="displayBody"
            class="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-zinc-800 dark:text-zinc-200"
          >{{ displayBody }}</pre>
          <div v-else class="text-sm text-zinc-400 py-8 text-center">{{ t('detail.noBody') }}</div>
          <div v-if="htmlBlocked" class="mt-3">
            <n-alert type="warning" :show-icon="false" :bordered="false" class="rounded-xl">
              <div class="flex items-center justify-between w-full">
                <span>{{ t('detail.htmlBlocked', { count: htmlBlocked }) }}</span>
                <n-button size="tiny" tertiary type="warning" @click="handleLoadRemoteImages">
                  <template #icon><n-icon><ImageRound /></n-icon></template>
                  {{ t('detail.loadRemoteImages') }}
                </n-button>
              </div>
            </n-alert>
          </div>
        </div>

        <!-- 附件 -->
        <div v-if="attachments.length" class="px-5 py-3.5 border-t border-zinc-100 dark:border-zinc-800/70 bg-zinc-50/50 dark:bg-zinc-900/30">
          <div class="text-xs font-semibold text-zinc-500 mb-2">{{ t('detail.attachments') }} ({{ attachments.length }})</div>
          <div class="flex flex-wrap gap-2">
            <div
              v-for="(att, i) in attachments"
              :key="i"
              class="flex items-center gap-2 text-xs bg-white dark:bg-zinc-800 border border-zinc-200/80 dark:border-zinc-700/80 text-zinc-700 dark:text-zinc-300 rounded-xl px-3 py-1.5 shadow-xs"
            >
              <span>📎</span>
              <span class="max-w-[220px] truncate font-medium">{{ att.name || att.id || ('attachment-' + (i + 1)) }}</span>
              <span v-if="att.size" class="text-zinc-400 font-mono">({{ fmtSize(att.size) }})</span>
              <span v-if="att.mimeType" class="text-zinc-400">{{ att.mimeType }}</span>
              <span class="text-zinc-400" :title="t('detail.attachmentNoDownload')">· {{ t('detail.metadataOnly') }}</span>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowBackRound, ImageRound, RefreshRound } from '@vicons/material'
import { sanitizeHtmlMail } from '../utils/sanitize-html-mail'
import { blockRemoteContent } from '../utils/remote-content-policy'
import { useScopedI18n } from '../i18n/app'
import { api } from '../api'
import { useGlobalState } from '../store'
import ThinkingBlock from '../components/ai/ThinkingBlock.vue'
import StreamMarkdown from '../components/ai/StreamMarkdown.vue'
import MessageActionToolbar from '../components/ai/MessageActionToolbar.vue'
import { useMessage } from 'naive-ui'

const { t } = useScopedI18n('unified')
const { userJwt, unifiedApiKey, autoLoadRemoteImages } = useGlobalState()
const route = useRoute()
const router = useRouter()
const message = useMessage()

const email = ref(null)
const loading = ref(true)
const error = ref('')
const marking = ref(false)
const starring = ref(false)
const authIdentity = computed(() => {
  const jwt = userJwt.value?.trim()
  if (jwt) return `user:${jwt}`
  const key = unifiedApiKey.value?.trim()
  return key ? `key:${key}` : ''
})
const hasAccess = computed(() => !!authIdentity.value)

// AI assistant state
const showAiPanel = ref(false)
const aiThinking = ref(false)
const aiDuration = ref(0)
const aiAnalysisText = ref('')
let aiTimer = null

// Per-mail consent for remote images, mirroring MailContentRenderer.
const showRemoteImages = ref(false)

watch(() => email.value?.id, () => {
  if (aiTimer) {
    clearTimeout(aiTimer)
    aiTimer = null
  }
  aiThinking.value = false
  aiAnalysisText.value = ''
  showRemoteImages.value = false
})

const generateAiAnalysis = () => {
  if (!email.value) return
  aiThinking.value = true
  aiAnalysisText.value = ''
  const start = Date.now()
  const body = displayBody.value || ''
  const subject = email.value.subject || '（无主题）'
  const sender = email.value.from_addr || '未知发件人'

  const codeMatches = body.match(/\b([0-9]{4,8}|[A-Z0-9]{5,8})\b/g) || []
  const validCodes = codeMatches.filter(c => !/^(19|20)\d\d$/.test(c) && !/^\d{4}-\d{2}/.test(c))

  if (aiTimer) clearTimeout(aiTimer)
  const analysisMailId = email.value.id
  aiTimer = setTimeout(() => {
    if (email.value?.id !== analysisMailId) return
    aiTimer = null
    aiThinking.value = false
    aiDuration.value = Number(((Date.now() - start) / 1000).toFixed(1))
    const codeLine = validCodes.length ? `- **提取验证码**：\`${validCodes.slice(0, 3).join(', ')}\`` : '- 未检测到明显验证码'
    aiAnalysisText.value = `### 📌 智能邮件要点速览\n- **发件人**：\`${sender}\`\n- **主题**：${subject}\n${codeLine}\n\n#### 核心正文提取\n> ${body.slice(0, 320).trim()}...`
  }, 400)
}

let loadRequestSeq = 0
const load = async () => {
  const requestId = ++loadRequestSeq
  const requestedId = String(route.params.id || '')
  const isCurrent = () =>
    requestId === loadRequestSeq
    && hasAccess.value
    && String(route.params.id || '') === requestedId
  if (!hasAccess.value) {
    email.value = null
    loading.value = false
    return
  }
  loading.value = true
  error.value = ''
  marking.value = false
  starring.value = false
  email.value = null
  try {
    const nextEmail = await api.unified.getEmail(requestedId)
    if (!isCurrent()) return
    email.value = nextEmail
  } catch (e) {
    if (!isCurrent()) return
    error.value = e.message || 'error'
  } finally {
    if (isCurrent()) {
      loading.value = false
    }
  }
}
watch([() => route.params.id, authIdentity], ([id, identity], [oldId, oldIdentity]) => {
  if (!identity) {
    loadRequestSeq += 1
    email.value = null
    loading.value = false
    error.value = ''
    return
  }
  if (id !== oldId || identity !== oldIdentity) {
    void load()
  }
})
onMounted(load)

onBeforeUnmount(() => {
  loadRequestSeq += 1
  if (aiTimer) clearTimeout(aiTimer)
})

const stripHtml = (html) =>
  String(html || '')
    .replace(/<(br\s*\/|p|div|\/p|\/div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

const sanitisedHtml = computed(() => {
  if (!email.value?.html_body) return { html: '', blocked: 0 }
  // Strict default: sanitizeHtmlMail blocks remote resources. Only when the user
  // opts in (per-mail button, or the global auto-load picture switch) do we lift
  // the remote <img> block — never scripts / event attrs / javascript: / CSS fetches.
  if (autoLoadRemoteImages.value || showRemoteImages.value) {
    return blockRemoteContent(email.value.html_body, { allowRemote: true })
  }
  return sanitizeHtmlMail(email.value.html_body)
})
const htmlBody = computed(() => sanitisedHtml.value.html)
const htmlBlocked = computed(() => sanitisedHtml.value.blocked)
const handleLoadRemoteImages = () => {
  showRemoteImages.value = true
}
const displayBody = computed(() => {
  if (email.value?.text_body) return email.value.text_body
  if (email.value?.html_body) return stripHtml(email.value.html_body)
  return ''
})

// Aggregator attachments use name/size/mimeType. Accept legacy aliases at the
// boundary, then render only normalized records so malformed JSON elements cannot
// cause template errors or leak unexpected values into the UI.
const normalizeAttachment = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const name = typeof value.name === 'string'
    ? value.name
    : typeof value.filename === 'string' ? value.filename : ''
  const size = Number(value.size)
  const mimeType = typeof value.mimeType === 'string'
    ? value.mimeType
    : typeof value.mime_type === 'string'
      ? value.mime_type
      : typeof value.content_type === 'string' ? value.content_type : ''
  const id = typeof value.id === 'string' ? value.id : ''
  if (!name && !id && !mimeType && (!Number.isFinite(size) || size < 0)) return null
  return {
    name,
    size: Number.isFinite(size) && size >= 0 ? size : 0,
    mimeType,
    id,
  }
}

const attachments = computed(() => {
  const raw = email.value?.attachments_json
  if (!raw) return []
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(arr) ? arr.map(normalizeAttachment).filter(Boolean) : []
  } catch {
    return []
  }
})

const markRead = async () => {
  const target = email.value
  if (!target || target.is_read) return
  const targetId = String(target.id)
  const targetIdentity = authIdentity.value
  marking.value = true
  try {
    await api.unified.markRead(target.id)
    if (
      email.value !== target ||
      authIdentity.value !== targetIdentity ||
      String(route.params.id || '') !== targetId
    ) return
    target.is_read = 1
    message.success(t('detail.markRead'))
  } catch (e) {
    if (
      email.value !== target ||
      authIdentity.value !== targetIdentity ||
      String(route.params.id || '') !== targetId
    ) return
    message.error(e.message || 'error')
  } finally {
    if (email.value === target) {
      marking.value = false
    }
  }
}

const toggleStar = async () => {
  const target = email.value
  if (!target) return
  const targetId = String(target.id)
  const targetIdentity = authIdentity.value
  starring.value = true
  try {
    const res = await api.unified.toggleStar(target.id)
    if (
      email.value !== target ||
      authIdentity.value !== targetIdentity ||
      String(route.params.id || '') !== targetId
    ) return
    target.is_starred = res.is_starred
    if (res.is_starred) {
      message.success('已标为星标邮件（正文永久保留）')
    } else {
      message.info('已取消星标')
    }
  } catch (e) {
    if (
      email.value !== target ||
      authIdentity.value !== targetIdentity ||
      String(route.params.id || '') !== targetId
    ) return
    message.error(e.message || '操作失败')
  } finally {
    if (email.value === target) {
      starring.value = false
    }
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
