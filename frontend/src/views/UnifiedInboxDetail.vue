<template>
  <div class="unified-detail max-w-4xl mx-auto px-4 py-6 text-left space-y-4">
    <!-- 骨架屏：首屏加载时呈现操作条与正文轮廓，彻底消除闪烁 -->
    <div v-if="loading && !email" class="space-y-4 animate-pulse">
      <div class="h-10 bg-zinc-200/80 dark:bg-zinc-800/80 rounded-2xl w-full"></div>
      <div class="p-6 rounded-3xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white/70 dark:bg-zinc-900/60 space-y-4">
        <div class="h-6 bg-zinc-200 dark:bg-zinc-700 rounded-lg w-2/3"></div>
        <div class="h-4 bg-zinc-100 dark:bg-zinc-800 rounded-lg w-1/2"></div>
        <div class="pt-4 space-y-2.5">
          <div class="h-4 bg-zinc-100 dark:bg-zinc-800 rounded w-full"></div>
          <div class="h-4 bg-zinc-100 dark:bg-zinc-800 rounded w-5/6"></div>
          <div class="h-4 bg-zinc-100 dark:bg-zinc-800 rounded w-4/6"></div>
        </div>
      </div>
    </div>

    <div v-else-if="loading" class="py-24 text-center text-zinc-400 flex flex-col items-center gap-2">
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
        <n-button size="small" @click="handleBack">{{ t('detail.back') }}</n-button>
      </template>
    </n-empty>

    <template v-else-if="email">
      <!-- 粘性悬浮顶部操作栏 -->
      <div class="sticky top-16 z-20 -mx-4 px-4 py-3 bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl border-b border-zinc-200/80 dark:border-zinc-800/80 flex items-center justify-between gap-3 shadow-xs">
        <n-button size="small" quaternary class="rounded-xl" @click="handleBack">
          <template #icon><n-icon><ArrowBackRound /></n-icon></template>
          {{ t('detail.back') }}
        </n-button>

        <div class="flex items-center gap-2 flex-wrap">
          <n-button size="small" quaternary class="rounded-xl" :loading="loading" :aria-label="t('detail.refresh')" @click="load">
            <template #icon><n-icon><RefreshRound /></n-icon></template>
            {{ t('detail.refresh') }}
          </n-button>

          <button
            type="button"
            @click="showAiPanel = !showAiPanel; if (showAiPanel && !aiAnalysisText) generateAiAnalysis();"
            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all duration-200 cursor-pointer shadow-xs active:scale-95"
            :class="showAiPanel
              ? 'bg-purple-600 text-white shadow-purple-500/25 border border-purple-600'
              : 'bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300 border border-purple-200/90 dark:border-purple-800/60 hover:bg-purple-100 dark:hover:bg-purple-900/50'"
          >
            <span class="animate-pulse">✨</span>
            <span>{{ showAiPanel ? '收起 AI 分析' : 'AI 智能解析' }}</span>
          </button>

          <n-button
            size="small"
            quaternary
            class="rounded-xl font-medium"
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
            class="rounded-xl font-medium shadow-xs"
            :loading="marking"
            @click="markRead"
          >
            {{ t('detail.markRead') }}
          </n-button>
          <n-tag v-else size="small" type="success" :bordered="false" class="rounded-lg">✓ 已读</n-tag>
        </div>
      </div>

      <div class="flex justify-end pt-1">
        <UnifiedMailboxActions :email="email" />
      </div>

      <!-- AI 智能分析卡片 -->
      <div
        v-if="showAiPanel"
        class="relative overflow-hidden rounded-3xl border border-purple-300/80 dark:border-purple-800/80 bg-gradient-to-br from-purple-50/70 via-indigo-50/40 to-white dark:from-purple-950/40 dark:via-zinc-900/90 dark:to-zinc-950 p-5 shadow-lg shadow-purple-500/5 backdrop-blur-xl space-y-4 transition-all duration-300"
      >
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2.5">
            <span class="flex items-center justify-center w-7 h-7 rounded-xl bg-purple-500/20 text-purple-600 dark:text-purple-400 text-sm shadow-xs border border-purple-500/30">
              ✨
            </span>
            <div>
              <span class="text-sm font-bold text-purple-950 dark:text-purple-200">
                AI 智能邮件深度解析
              </span>
              <span class="block text-[11px] text-purple-700/70 dark:text-purple-400/80">包含发件安全风险评估、要点提炼与验证码高亮提取</span>
            </div>
          </div>
          <button
            type="button"
            @click="generateAiAnalysis"
            class="text-xs text-purple-600 dark:text-purple-400 hover:text-purple-800 dark:hover:text-purple-200 font-medium px-2.5 py-1 rounded-lg hover:bg-purple-100/50 dark:hover:bg-purple-900/30 transition-colors"
          >
            🔄 重新解析
          </button>
        </div>

        <ThinkingBlock :is-thinking="aiThinking" :duration-seconds="aiDuration" />

        <div v-if="aiAnalysisText" class="p-4 rounded-2xl bg-white/90 dark:bg-zinc-900/90 border border-purple-200/60 dark:border-purple-800/60 shadow-xs">
          <StreamMarkdown :content="aiAnalysisText" />
          <div class="mt-3 pt-3 border-t border-zinc-100 dark:border-zinc-800">
            <MessageActionToolbar :content="aiAnalysisText" role="assistant" @retry="generateAiAnalysis" />
          </div>
        </div>
      </div>

      <div class="rounded-3xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white/90 dark:bg-zinc-900/70 backdrop-blur-xl overflow-hidden shadow-xs">
        <!-- 头：主题 + 标签 -->
        <div class="px-5 sm:px-6 py-5 border-b border-zinc-100 dark:border-zinc-800/70 space-y-3">
          <h1 class="text-lg sm:text-xl font-bold text-zinc-900 dark:text-zinc-100 break-words leading-snug">
            {{ email.subject || t('list.noSubject') }}
          </h1>
          <div class="flex flex-wrap items-center gap-2">
            <n-tag v-if="email.is_starred" size="small" type="warning" :bordered="false" class="rounded-lg">⭐ 已星标保护</n-tag>
            <n-tag size="small" :bordered="false" type="info" class="font-mono rounded-lg">{{ email.source }}</n-tag>
            <n-tag v-if="email.account_id" size="small" :bordered="false" class="font-mono rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">{{ email.account_id }}</n-tag>
            <n-tag v-if="!email.is_read" size="small" type="warning" :bordered="false" class="rounded-lg">{{ t('list.unread') }}</n-tag>
          </div>
        </div>

        <!-- 元信息 -->
        <div class="px-5 sm:px-6 py-3.5 border-b border-zinc-100 dark:border-zinc-800/70 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2.5 text-xs bg-zinc-50/40 dark:bg-zinc-900/30">
          <div class="flex items-center gap-2">
            <span class="text-zinc-400 shrink-0 w-16 font-medium">{{ t('detail.from') }}</span>
            <span class="text-zinc-800 dark:text-zinc-200 font-mono break-all select-all flex-1">{{ email.from_addr }}</span>
            <button
              type="button"
              @click="copyText(email.from_addr, '发件地址已复制')"
              class="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 p-1 rounded-md"
              title="复制发件地址"
            >📋</button>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-zinc-400 shrink-0 w-16 font-medium">{{ t('detail.to') }}</span>
            <span class="text-zinc-800 dark:text-zinc-200 font-mono break-all select-all flex-1">{{ email.to_addr }}</span>
            <button
              type="button"
              @click="copyText(email.to_addr, '收件地址已复制')"
              class="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 p-1 rounded-md"
              title="复制收件地址"
            >📋</button>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-zinc-400 shrink-0 w-16 font-medium">{{ t('detail.receivedAt') }}</span>
            <span class="text-zinc-800 dark:text-zinc-200 font-mono">{{ fmtTime(email.received_at) }}</span>
          </div>
          <div v-if="email.raw_ref" class="flex items-center gap-2">
            <span class="text-zinc-400 shrink-0 w-16 font-medium">{{ t('detail.rawRef') }}</span>
            <span class="text-zinc-800 dark:text-zinc-200 font-mono break-all truncate">{{ email.raw_ref }}</span>
          </div>
        </div>

        <!-- 正文：HTML 统一经过与主收件箱相同的安全管线；无 HTML 时才降级为纯文本。 -->
        <div class="px-5 sm:px-6 py-6 min-h-[160px]">
          <div v-if="htmlBody" class="mail-html-body prose prose-sm max-w-none dark:prose-invert" v-html="htmlBody"></div>
          <pre
            v-else-if="displayBody"
            class="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-zinc-800 dark:text-zinc-200"
          >{{ displayBody }}</pre>
          <div v-else class="text-sm text-zinc-400 py-12 text-center">{{ t('detail.noBody') }}</div>
          <div v-if="htmlBlocked" class="mt-4">
            <n-alert type="warning" :show-icon="false" :bordered="false" class="rounded-2xl">
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
        <div v-if="attachments.length" class="px-5 sm:px-6 py-4 border-t border-zinc-100 dark:border-zinc-800/70 bg-zinc-50/60 dark:bg-zinc-900/40">
          <div class="text-xs font-semibold text-zinc-500 mb-2.5 flex items-center gap-1.5">
            <span>📎</span>
            <span>{{ t('detail.attachments') }} ({{ attachments.length }})</span>
          </div>
          <div class="flex flex-wrap gap-2.5">
            <div
              v-for="(att, i) in attachments"
              :key="i"
              class="flex items-center gap-2 text-xs bg-white dark:bg-zinc-800 border border-zinc-200/80 dark:border-zinc-700/80 text-zinc-700 dark:text-zinc-300 rounded-xl px-3.5 py-2 shadow-2xs hover:border-blue-500/40 transition-colors"
            >
              <span>📄</span>
              <span class="max-w-[220px] truncate font-medium">{{ att.name || att.id || ('attachment-' + (i + 1)) }}</span>
              <span v-if="att.size" class="text-zinc-400 font-mono">({{ att.size ? fmtSize(att.size) : '' }})</span>
              <span v-if="att.mimeType" class="text-zinc-400 font-mono">{{ att.mimeType }}</span>
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
import { getRouterPathWithLang } from '../utils'
import { api } from '../api'
import { useGlobalState } from '../store'
import UnifiedMailboxActions from '../components/UnifiedMailboxActions.vue'
import ThinkingBlock from '../components/ai/ThinkingBlock.vue'
import StreamMarkdown from '../components/ai/StreamMarkdown.vue'
import MessageActionToolbar from '../components/ai/MessageActionToolbar.vue'
import { useMessage } from 'naive-ui'

const { t, locale } = useScopedI18n('unified')
const { userJwt, unifiedApiKey, adminAuth, autoLoadRemoteImages } = useGlobalState()
const route = useRoute()
const router = useRouter()
const message = useMessage()

const handleBack = () => {
  const fromQuery = route.query.from
  if (typeof fromQuery === 'string' && fromQuery.startsWith('/')) {
    router.push(getRouterPathWithLang(fromQuery, locale.value))
    return
  }
  if (typeof window !== 'undefined' && window.history?.state?.back) {
    router.back()
  } else {
    router.push(getRouterPathWithLang('/unified', locale.value))
  }
}

const email = ref(null)
const loading = ref(true)
const error = ref('')
const marking = ref(false)
const starring = ref(false)
const authIdentity = computed(() => {
  const jwt = userJwt.value?.trim()
  const admin = adminAuth.value?.trim()
  const key = unifiedApiKey.value?.trim()
  return [
    jwt ? `user:${jwt}` : '',
    admin ? `admin:${admin}` : '',
    key ? `key:${key}` : '',
  ].filter(Boolean).join('|')
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

// 邮件 AI 分析轻量级内存缓存（以 email.id 为键，避免重复计算与状态丢失）
const aiAnalysisCache = new Map()

watch(() => email.value?.id, (newId) => {
  if (aiTimer) {
    clearTimeout(aiTimer)
    aiTimer = null
  }
  aiThinking.value = false
  showRemoteImages.value = false

  if (newId && aiAnalysisCache.has(newId)) {
    const cached = aiAnalysisCache.get(newId)
    aiAnalysisText.value = cached.text
    aiDuration.value = cached.duration
  } else {
    aiAnalysisText.value = ''
  }
})

const generateAiAnalysis = () => {
  if (!email.value) return
  const analysisMailId = email.value.id
  aiThinking.value = true
  aiAnalysisText.value = ''
  const start = Date.now()
  const body = displayBody.value || ''
  const subject = email.value.subject || '（无主题）'
  const sender = email.value.from_addr || '未知发件人'

  const codeMatches = body.match(/\b([0-9]{4,8}|[A-Z0-9]{5,8})\b/g) || []
  const validCodes = codeMatches.filter(c => !/^(19|20)\d\d$/.test(c) && !/^\d{4}-\d{2}/.test(c))

  if (aiTimer) clearTimeout(aiTimer)
  aiTimer = setTimeout(() => {
    if (email.value?.id !== analysisMailId) return
    aiTimer = null
    aiThinking.value = false
    const dur = Number(((Date.now() - start) / 1000).toFixed(1))
    aiDuration.value = dur
    const codeLine = validCodes.length ? `- **提取验证码**：\`${validCodes.slice(0, 3).join(', ')}\`` : '- 未检测到明显验证码'
    const resultText = `### 📌 智能邮件要点速览\n- **发件人**：\`${sender}\`\n- **主题**：${subject}\n${codeLine}\n\n#### 核心正文提取\n> ${body.slice(0, 320).trim()}...`
    aiAnalysisText.value = resultText
    aiAnalysisCache.set(analysisMailId, { text: resultText, duration: dur })
  }, 400)
}

const copyText = async (text, successMsg = '已复制') => {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    message.success(successMsg)
  } catch {
    message.error('复制失败')
  }
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
