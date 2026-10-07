<template>
  <div class="unified-detail workspace-page mail-reader">
    <div class="mail-reader-toolbar">
      <n-button quaternary @click="handleBack"><template #icon><MailIcon name="arrow-left" :size="17" /></template>{{ w('backInbox') }}</n-button>
      <div v-if="email" class="mail-reader-toolbar__actions">
        <n-button quaternary :loading="loading" :aria-label="w('refresh')" @click="load"><template #icon><MailIcon name="refresh" :size="16" /></template></n-button>
        <n-button :secondary="showAiPanel" :type="showAiPanel ? 'primary' : 'default'" @click="showAiPanel = !showAiPanel; if (showAiPanel && !aiAnalysisText) generateAiAnalysis()"><template #icon><MailIcon name="sparkles" :size="16" /></template>{{ w(showAiPanel ? 'hideOverview' : 'overview') }}</n-button>
        <n-button :loading="starring" :type="email.is_starred ? 'warning' : 'default'" :aria-pressed="Boolean(email.is_starred)" @click="toggleStar"><template #icon><MailIcon name="star" :size="17" /></template>{{ w(email.is_starred ? 'removeStar' : 'addStar') }}</n-button>
        <n-button v-if="!email.is_read" :loading="marking" @click="markRead"><template #icon><MailIcon name="check-circle" :size="16" /></template>{{ w('markRead') }}</n-button>
        <UnifiedMailboxActions :email="email" />
      </div>
    </div>
    <div v-if="loading" class="workspace-panel p-8 space-y-5" aria-busy="true"><n-skeleton text width="65%" height="30px" /><n-skeleton text width="40%" /><n-skeleton text :repeat="5" /></div>
    <WorkspaceEmpty v-else-if="!hasAccess" icon="lock" :title="w('privateSpace')" :description="t('auth.loginRequired')"><n-button type="primary" @click="router.push(getRouterPathWithLang('/user', locale))">{{ w('login') }}</n-button></WorkspaceEmpty>
    <WorkspaceEmpty v-else-if="error && !email" icon="circle-x" :title="w('retry')" :description="error"><n-button @click="load">{{ w('retry') }}</n-button></WorkspaceEmpty>
    <template v-else-if="email">
      <section v-if="showAiPanel" class="mail-overview">
        <div class="mail-overview__heading"><MailIcon name="sparkles" :size="21" /><div><strong>{{ w('overview') }}</strong><p>{{ w('overviewHint') }}</p></div><button type="button" class="workspace-link" @click="generateAiAnalysis">{{ w('regenerate') }}</button></div>
        <StreamMarkdown v-if="aiAnalysisText" :content="aiAnalysisText" />
        <MessageActionToolbar v-if="aiAnalysisText" :content="aiAnalysisText" :show-feedback="false" :action-labels="{ copy: w('copy'), copied: w('copied'), copyFailed: w('copyFailed'), retry: w('regenerate') }" @retry="generateAiAnalysis" />
      </section>
      <article class="mail-reader-document">
        <div class="mail-reader-heading">
          <div class="flex items-center gap-2"><span class="workspace-eyebrow">{{ w('reading') }}</span><n-tag v-if="email.is_starred" size="small" :bordered="false" type="warning"><MailIcon name="star" :size="12" /> {{ w('protected') }}</n-tag><n-tag v-if="email.is_read" size="small" :bordered="false">{{ w('read') }}</n-tag></div>
          <h1>{{ email.subject || w('noSubject') }}</h1>
          <div class="mail-reader-sender"><div class="inbox-sender-avatar">{{ email.from_addr?.[0]?.toUpperCase() || '?' }}</div><div class="mail-reader-sender__info"><strong>{{ email.from_addr }}</strong><span>{{ w('recipient') }} {{ email.to_addr }}</span></div><button type="button" class="mail-icon-button" :aria-label="w('copy') + ' ' + w('sender')" :title="w('copy') + ' ' + w('sender')" @click="copyText(email.from_addr)"><MailIcon name="copy" :size="15" /></button></div>
        </div>
        <div class="mail-reader-meta"><div><span class="label">{{ t('detail.receivedAt') }}</span><span class="value">{{ fmtTime(email.received_at) }}</span></div><div><span class="label">{{ w('accounts') }}</span><span class="value">{{ email.account_id || email.to_addr }}</span></div></div>
        <div class="mail-reader-body">
          <n-alert v-if="htmlBlocked" type="info" :show-icon="false" class="mb-6"><div class="flex items-center justify-between gap-3 flex-wrap"><span>{{ t('detail.htmlBlocked', { count: htmlBlocked }) }}</span><n-button size="small" @click="handleLoadRemoteImages"><template #icon><MailIcon name="image" :size="15" /></template>{{ t('detail.loadRemoteImages') }}</n-button></div></n-alert>
          <div v-if="htmlBody" class="mail-html-body mail-html" v-html="htmlBody"></div>
          <pre v-else-if="displayBody" class="whitespace-pre-wrap break-words font-sans text-sm leading-loose">{{ displayBody }}</pre>
          <WorkspaceEmpty v-else icon="mail" :title="t('detail.noBody')" />
        </div>
        <div v-if="attachments.length" class="mail-reader-attachments">
          <div class="flex items-center gap-2 text-xs mb-4"><MailIcon name="paperclip" :size="16" />{{ t('detail.attachments') }} · {{ attachments.length }}</div>
          <div class="flex flex-wrap gap-3"><div v-for="(att, i) in attachments" :key="i" class="mail-attachment"><MailIcon name="paperclip" :size="18" /><div><strong>{{ att.name || att.id || ('attachment-' + (i + 1)) }}</strong><span>{{ att.size ? fmtSize(att.size) + ' · ' : '' }}{{ att.mimeType }}</span><span :title="t('detail.attachmentNoDownload')">{{ t('detail.metadataOnly') }}</span></div></div></div>
        </div>
      </article>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import MailIcon from '../components/ui/MailIcon.vue'
import WorkspaceEmpty from '../components/ui/WorkspaceEmpty.vue'
import { extractSubjectCode } from '../utils/subject-code'
import { markdownText } from '../utils/markdown-text'
import { sanitizeHtmlMail } from '../utils/sanitize-html-mail'
import { blockRemoteContent } from '../utils/remote-content-policy'
import { useScopedI18n } from '../i18n/app'
import { getRouterPathWithLang } from '../utils'
import { replaceLocaleInFullPath } from '../i18n/utils'
import { api } from '../api'
import { useGlobalState } from '../store'
import UnifiedMailboxActions from '../components/UnifiedMailboxActions.vue'
import StreamMarkdown from '../components/ai/StreamMarkdown.vue'
import MessageActionToolbar from '../components/ai/MessageActionToolbar.vue'
import { useMessage } from 'naive-ui'

const { t, locale } = useScopedI18n('unified')
const { t: w } = useScopedI18n('workspace')
const { userJwt, unifiedApiKey, adminAuth, autoLoadRemoteImages } = useGlobalState()
const route = useRoute()
const router = useRouter()
const message = useMessage()

const handleBack = () => {
  const fromQuery = route.query.from
  if (typeof fromQuery === 'string' && fromQuery.startsWith('/')) {
    router.push(replaceLocaleInFullPath(fromQuery, locale.value || locale))
    return
  }
  if (typeof window !== 'undefined' && window.history?.state?.back) {
    router.back()
  } else {
    router.push(getRouterPathWithLang('/unified', locale.value || locale))
  }
}

/** @type {import('vue').Ref<import('../api/contracts').UnifiedEmailDetail | null>} */
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

// Local mail overview; no model call or simulated generation state.
const showAiPanel = ref(false)
const aiAnalysisText = ref('')

// Per-mail consent for remote images, mirroring MailContentRenderer.
const showRemoteImages = ref(false)

// Derived presentation only: discard it whenever the loaded mail changes.
watch(email, () => {
  showRemoteImages.value = false
  aiAnalysisText.value = ''
  if (showAiPanel.value && email.value) generateAiAnalysis()
})

const generateAiAnalysis = () => {
  if (!email.value) return
  aiAnalysisText.value = ''
  const body = displayBody.value || ''
  const subject = email.value.subject || w('noSubject')
  const sender = email.value.from_addr || w('sender')

  // Reuse the inbox extractor: two linear scans, at most two candidates,
  // without allocating a global match array for a potentially long body.
  const validCodes = [...new Set([extractSubjectCode(subject), extractSubjectCode(body)].filter(Boolean))]

  const codeLine = validCodes.length ? `- **${w('possibleCodes')}**: \`${validCodes.slice(0, 3).join(', ')}\`` : `- ${w('noCodes')}`
  const resultText = `### ${w('overviewHeading')}\n- **${w('sender')}**: ${markdownText(sender)}\n- **${w('subject')}**: ${markdownText(subject)}\n${codeLine}\n\n#### ${w('bodyExcerpt')}\n${markdownText(body.slice(0, 320).trim())}${body.length > 320 ? '…' : ''}`
  aiAnalysisText.value = resultText
}

const copyText = async (text, successMsg = w('copied')) => {
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

let loadRequestSeq = 0
let disposed = false
/** @type {AbortController | undefined} */
let detailController
const load = async () => {
  detailController?.abort()
  const controller = new AbortController()
  detailController = controller
  const requestId = ++loadRequestSeq
  const requestedId = String(route.params.id || '')
  const isCurrent = () =>
    !disposed && !controller.signal.aborted && requestId === loadRequestSeq
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
    const nextEmail = await api.unified.getEmail(requestedId, { signal: controller.signal })
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
    detailController?.abort()
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
  disposed = true
  detailController?.abort()
  loadRequestSeq += 1
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
  if (!target || target.is_read || marking.value) return
  const targetId = String(target.id)
  const targetIdentity = authIdentity.value
  marking.value = true
  try {
    const result = await api.unified.markRead(target.id, { signal: detailController?.signal })
    if (
      disposed || email.value !== target ||
      authIdentity.value !== targetIdentity ||
      String(route.params.id || '') !== targetId
    ) return
    target.is_read = result.is_read ?? 1
    message.success(t('detail.markRead'))
  } catch (e) {
    if (
      disposed || email.value !== target ||
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
  if (!target || starring.value) return
  const targetId = String(target.id)
  const targetIdentity = authIdentity.value
  starring.value = true
  try {
    const res = await api.unified.toggleStar(target.id, target.is_starred ? 0 : 1, { signal: detailController?.signal })
    if (
      disposed || email.value !== target ||
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
      disposed || email.value !== target ||
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
