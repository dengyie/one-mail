<script setup>
import { ref, computed, watch } from "vue";
import { useScopedI18n } from '@/i18n/app'
import {
  CloudDownloadRound, ReplyFilled, ForwardFilled, FullscreenRound, ImageRound,
  AutoAwesomeRound, CloseRound
} from '@vicons/material'
import ShadowHtmlComponent from "./ShadowHtmlComponent.vue";
import AiExtractInfo from "./AiExtractInfo.vue";
import ThinkingBlock from "./ai/ThinkingBlock.vue";
import StreamMarkdown from "./ai/StreamMarkdown.vue";
import PromptChips from "./ai/PromptChips.vue";
import MessageActionToolbar from "./ai/MessageActionToolbar.vue";
import { getDownloadEmlUrl } from '../utils/email-parser';
import { sanitizeHtmlMail } from '../utils/sanitize-html-mail';
import { blockRemoteContent } from '../utils/remote-content-policy';
import { utcToLocalDate } from '../utils';
import { useGlobalState } from '../store';
import { useMessage } from 'naive-ui';

const message = useMessage();
const { preferShowTextMail, useIframeShowMail, useUTCDate, isDark, autoLoadRemoteImages, sendMailModel, indexTab } = useGlobalState();
const { t } = useScopedI18n('components.MailContentRenderer');

const props = defineProps({
  mail: {
    type: Object,
    required: true
  },
  showEMailTo: {
    type: Boolean,
    default: true
  },
  enableUserDeleteEmail: {
    type: Boolean,
    default: false
  },
  showReply: {
    type: Boolean,
    default: false
  },
  showSaveS3: {
    type: Boolean,
    default: false
  },
  onDelete: {
    type: Function,
    default: () => { }
  },
  onReply: {
    type: Function,
    default: () => { }
  },
  onForward: {
    type: Function,
    default: () => { }
  },
  onSaveToS3: {
    type: Function,
    default: () => { }
  }
});

const showTextMail = ref(preferShowTextMail.value);
const showAttachments = ref(false);
const curAttachments = ref([]);
const attachmentLoding = ref(false);
const showFullscreen = ref(false);

// AI Assistant state
const showAiPanel = ref(false);
const aiThinking = ref(false);
const aiThinkingDuration = ref(0);
const aiAnalysisText = ref('');
const activePrompt = ref('');

const aiPromptSuggestions = [
  '📌 提炼邮件核心要点',
  '🔑 提取验证码与关键链接',
  '📝 生成礼貌确认回复',
  '⛔ 生成委婉谢绝回复',
  '🎯 整理待办事项清单',
];

// Per-mail consent for remote images
const showRemoteImages = ref(false);
watch(() => props.mail.id, () => {
  showRemoteImages.value = false;
  showAiPanel.value = false;
  aiAnalysisText.value = '';
});

const processedMail = computed(() => {
  if (autoLoadRemoteImages.value || showRemoteImages.value) {
    const { html, blocked } = blockRemoteContent(props.mail.message, { allowRemote: true });
    return { message: html, blocked };
  }
  const { html, blocked } = sanitizeHtmlMail(props.mail.message);
  return { message: html, blocked };
});

const handleLoadRemoteImages = () => {
  showRemoteImages.value = true;
};

const handleDelete = () => {
  props.onDelete();
};

const handleViewAttachments = () => {
  curAttachments.value = props.mail.attachments;
  showAttachments.value = true;
};

const handleReply = () => {
  props.onReply();
};

const handleForward = () => {
  props.onForward();
};

const handleSaveToS3 = async (filename, blob) => {
  attachmentLoding.value = true;
  try {
    await props.onSaveToS3(filename, blob);
  } finally {
    attachmentLoding.value = false;
  }
};

// Deterministic intelligent heuristic email analysis
const generateAiAnalysis = (promptType) => {
  activePrompt.value = promptType;
  aiThinking.value = true;
  aiAnalysisText.value = '';
  
  const startTime = Date.now();
  const rawText = props.mail.text || (props.mail.message ? props.mail.message.replace(/<[^>]+>/g, ' ') : '');
  const subject = props.mail.subject || '（无主题）';
  const sender = props.mail.source || '未知发件人';
  
  // Extract codes / links / dates using patterns
  const codeMatches = rawText.match(/\b([0-9]{4,8}|[A-Z0-9]{5,8})\b/g) || [];
  const validCodes = codeMatches.filter(c => !/^(19|20)\d\d$/.test(c) && !/^\d{4}-\d{2}/.test(c));
  const linkMatches = rawText.match(/https?:\/\/[^\s<>"']+/g) || [];
  
  setTimeout(() => {
    aiThinking.value = false;
    aiThinkingDuration.value = Number(((Date.now() - startTime) / 1000).toFixed(1));
    
    if (promptType.includes('提炼邮件核心要点') || promptType.includes('核心要点')) {
      aiAnalysisText.value = `### 📌 邮件速览\n- **发件人**：\`${sender}\`\n- **主题**：${subject}\n\n#### 核心摘要\n${rawText.slice(0, 300).trim()}...\n\n---\n*分析完成，如需回复可直接点击下方快捷提示。*`;
    } else if (promptType.includes('提取验证码') || promptType.includes('验证码')) {
      const codeList = validCodes.slice(0, 3).map(c => `- **验证码**：\`${c}\``).join('\n') || '- 未识别到明显验证码';
      const linkList = linkMatches.slice(0, 3).map(l => `- [${l}](${l})`).join('\n') || '- 无关键链接';
      aiAnalysisText.value = `### 🔑 凭据与链接识别\n${codeList}\n\n#### 关键跳转链接\n${linkList}`;
    } else if (promptType.includes('礼貌确认回复') || promptType.includes('确认回复')) {
      const replyBody = `您好！\n\n已收到关于“${subject}”的邮件，我已了解相关内容。如有后续进展我会及时与您同步。\n\n祝好！`;
      aiAnalysisText.value = `### 📝 建议回复草稿（礼貌确认）\n\`\`\`text\n${replyBody}\n\`\`\`\n\n> 💡 *点击复制后可直接填入回复框。*`;
    } else if (promptType.includes('委婉谢绝回复') || promptType.includes('谢绝')) {
      const declineBody = `您好！\n\n感谢您的来信与邀请。由于近期时间安排冲突，暂时无法参与本次相关事宜，还望见谅。\n\n祝一切顺利！`;
      aiAnalysisText.value = `### ⛔ 建议回复草稿（委婉谢绝）\n\`\`\`text\n${declineBody}\n\`\`\`\n\n> 💡 *点击复制后可直接填入回复框。*`;
    } else if (promptType.includes('待办事项') || promptType.includes('清单')) {
      aiAnalysisText.value = `### 🎯 待办事项提取\n- [ ] **确认并归档** 来自 \`${sender}\` 的邮件\n- [ ] **核验主题**：${subject}\n- [ ] **跟进操作**：根据正文内容执行相应确认或登录操作`;
    } else {
      aiAnalysisText.value = `### 💡 智能分析结果\n- **发件人**：\`${sender}\`\n- **主题**：${subject}\n- **主要内容**：\n> ${rawText.slice(0, 240)}...`;
    }
  }, 400);
};

const handleSelectPrompt = (p) => {
  generateAiAnalysis(p);
};

const handleCopyAiContent = async () => {
  try {
    await navigator.clipboard.writeText(aiAnalysisText.value);
    message.success('已复制分析结果');
  } catch {
    message.error('复制失败');
  }
};
</script>

<template>
  <div class="mail-content-renderer space-y-3 text-left">
    <!-- 邮件信息标签与操作栏 -->
    <div class="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-zinc-200/60 dark:border-zinc-800/60">
      <div class="flex flex-wrap items-center gap-1.5">
        <n-tag size="small" type="info" :bordered="false">ID: {{ mail.id }}</n-tag>
        <n-tag size="small" :bordered="false">{{ utcToLocalDate(mail.created_at, useUTCDate.value) }}</n-tag>
        <n-tag size="small" type="info" :bordered="false" class="max-w-[200px] truncate">
          FROM: {{ mail.source }}
        </n-tag>
        <n-tag v-if="showEMailTo" size="small" :bordered="false" class="max-w-[200px] truncate">
          TO: {{ mail.address }}
        </n-tag>
      </div>

      <!-- 操作按钮群 -->
      <div class="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          @click="showAiPanel = !showAiPanel; if (showAiPanel && !aiAnalysisText) generateAiAnalysis(aiPromptSuggestions[0]);"
          class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800/50 hover:bg-purple-100 dark:hover:bg-purple-900/50 transition-colors cursor-pointer shadow-xs"
        >
          <n-icon :component="AutoAwesomeRound" />
          <span>{{ showAiPanel ? '关闭 AI 分析' : '✨ AI 助手' }}</span>
        </button>

        <n-popconfirm v-if="enableUserDeleteEmail" @positive-click="handleDelete">
          <template #trigger>
            <n-button tertiary type="error" size="small">{{ t('delete') }}</n-button>
          </template>
          {{ t('deleteMailTip') }}
        </n-popconfirm>

        <n-button v-if="mail.attachments && mail.attachments.length > 0" size="small" tertiary type="info"
          @click="handleViewAttachments">
          {{ t('attachments') }} ({{ mail.attachments.length }})
        </n-button>

        <n-button tag="a" target="_blank" tertiary type="info" size="small" :download="mail.id + '.eml'"
          :href="getDownloadEmlUrl(mail.raw)">
          <template #icon>
            <n-icon :component="CloudDownloadRound" />
          </template>
          {{ t('downloadMail') }}
        </n-button>

        <n-button v-if="showReply" size="small" tertiary type="info" @click="handleReply">
          <template #icon>
            <n-icon :component="ReplyFilled" />
          </template>
          {{ t('reply') }}
        </n-button>

        <n-button v-if="showReply" size="small" tertiary type="info" @click="handleForward">
          <template #icon>
            <n-icon :component="ForwardFilled" />
          </template>
          {{ t('forward') }}
        </n-button>

        <n-button size="small" tertiary type="info" @click="showTextMail = !showTextMail">
          {{ showTextMail ? t('showHtmlMail') : t('showTextMail') }}
        </n-button>

        <n-button size="small" tertiary type="info" @click="showFullscreen = true">
          <template #icon>
            <n-icon :component="FullscreenRound" />
          </template>
          {{ t('fullscreen') }}
        </n-button>
      </div>
    </div>

    <!-- AI 提取关键信息 (验证码/链接) -->
    <AiExtractInfo :metadata="mail.metadata" />

    <!-- 外部资源阻断提示 -->
    <n-alert v-if="processedMail.blocked" type="warning" :show-icon="false" :bordered="false"
      class="remote-images-banner rounded-xl">
      <div class="flex items-center justify-between w-full">
        <span>{{ t('remoteImagesBlocked', { count: processedMail.blocked }) }}</span>
        <n-button size="tiny" tertiary type="warning" @click="handleLoadRemoteImages">
          <template #icon>
            <n-icon :component="ImageRound" />
          </template>
          {{ t('loadRemoteImages') }}
        </n-button>
      </div>
    </n-alert>

    <!-- AI 助手交互面板 (基于 awesome-ui-kit 组件) -->
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
            AI 邮件智能助理
          </span>
        </div>
        <button
          type="button"
          @click="showAiPanel = false"
          class="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 p-1 rounded-md transition-colors"
        >
          <n-icon :component="CloseRound" />
        </button>
      </div>

      <!-- 快捷提示 PromptChips -->
      <PromptChips :suggestions="aiPromptSuggestions" @select="handleSelectPrompt" />

      <!-- 思考过程 ThinkingBlock -->
      <ThinkingBlock :is-thinking="aiThinking" :duration-seconds="aiThinkingDuration" />

      <!-- 流式/格式化 Markdown 展示 StreamMarkdown -->
      <div v-if="aiAnalysisText" class="p-3 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200/80 dark:border-zinc-800">
        <StreamMarkdown :content="aiAnalysisText" />
        <MessageActionToolbar
          :content="aiAnalysisText"
          role="assistant"
          @retry="generateAiAnalysis(activePrompt || aiPromptSuggestions[0])"
        />
      </div>
    </div>

    <!-- 邮件内容主体 -->
    <div class="mail-content rounded-xl overflow-hidden" :class="{ 'dark-mode': isDark }">
      <pre v-if="showTextMail" class="mail-text p-4 bg-zinc-50 dark:bg-zinc-900/50 rounded-xl border border-zinc-200/60 dark:border-zinc-800/60">{{ mail.text }}</pre>
      <iframe v-else-if="useIframeShowMail" :srcdoc="processedMail.message" class="mail-iframe rounded-xl border border-zinc-200/60 dark:border-zinc-800/60">
      </iframe>
      <ShadowHtmlComponent v-else :key="mail.id" :htmlContent="processedMail.message" :isDark="isDark" class="mail-html" />
    </div>
  </div>

  <!-- 全屏抽屉 -->
  <n-drawer v-model:show="showFullscreen" width="100%" placement="bottom" :trap-focus="false" :block-scroll="false"
    style="height: 100vh;">
    <n-drawer-content :title="mail.subject" closable>
      <div class="fullscreen-mail-content text-left" :class="{ 'dark-mode': isDark }">
        <pre v-if="showTextMail" class="mail-text">{{ mail.text }}</pre>
        <iframe v-else-if="useIframeShowMail" :srcdoc="processedMail.message" class="mail-iframe">
        </iframe>
        <ShadowHtmlComponent v-else :key="mail.id" :htmlContent="processedMail.message" :isDark="isDark" class="mail-html" />
      </div>
    </n-drawer-content>
  </n-drawer>

  <!-- 附件模态框 -->
  <n-modal v-model:show="showAttachments" preset="dialog" title="Dialog">
    <template #header>
      <div>{{ t('attachments') }}</div>
    </template>
    <n-spin v-model:show="attachmentLoding">
      <n-list hoverable clickable>
        <n-list-item v-for="row in curAttachments" v-bind:key="row.id">
          <n-thing class="center" :title="row.filename">
            <template #description>
              <n-space>
                <n-tag type="info">Size: {{ row.size }}</n-tag>
                <n-button v-if="showSaveS3" @click="handleSaveToS3(row.filename, row.blob)" ghost type="info" size="small">
                  {{ t('saveToS3') }}
                </n-button>
              </n-space>
            </template>
          </n-thing>
          <template #suffix>
            <n-button tag="a" target="_blank" tertiary type="info" size="small" :download="row.filename" :href="row.url">
              <n-icon :component="CloudDownloadRound" />
            </n-button>
          </template>
        </n-list-item>
      </n-list>
    </n-spin>
  </n-modal>
</template>

<style scoped>
.mail-content-renderer {
  display: flex;
  flex-direction: column;
}

.mail-content {
  margin-top: 10px;
  flex: 1;
}

.mail-text {
  white-space: pre-wrap;
  word-wrap: break-word;
  margin: 0;
  font-family: inherit;
  font-size: 14px;
  line-height: 1.6;
}

.dark-mode .mail-text {
  color: #e0e0e0;
}

.mail-iframe {
  width: 100%;
  height: 100%;
  border: none;
  min-height: 480px;
}

.dark-mode .mail-iframe {
  background-color: #fff;
}

.mail-html {
  width: 100%;
  height: 100%;
}

.center {
  text-align: center;
}

.fullscreen-mail-content {
  height: calc(100vh - 120px);
  overflow: auto;
}

.fullscreen-mail-content .mail-iframe {
  min-height: calc(100vh - 120px);
}
</style>
