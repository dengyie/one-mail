<script setup>
import { computed, ref } from 'vue';
import { useScopedI18n } from '@/i18n/app';
import { ContentCopyOutlined, LinkRound, CodeRound, CheckCircleRound } from '@vicons/material';
import { useMessage } from 'naive-ui';
import { useGlobalState } from '../store';

const message = useMessage();
const { isDark } = useGlobalState();
const copied = ref(false);

const { t } = useScopedI18n('components.AiExtractInfo');

const props = defineProps({
  metadata: {
    type: String,
    default: null
  },
  compact: {
    type: Boolean,
    default: false
  }
});

const aiExtract = computed(() => {
  if (!props.metadata) return null;
  try {
    const data = JSON.parse(props.metadata);
    return data.ai_extract || null;
  } catch (e) {
    return null;
  }
});

const typeLabel = computed(() => {
  if (!aiExtract.value) return '';
  const typeMap = {
    auth_code: t('authCode') || '验证码',
    auth_link: t('authLink') || '验证链接',
    service_link: t('serviceLink') || '服务链接',
    subscription_link: t('subscriptionLink') || '订阅链接',
    other_link: t('otherLink') || '链接',
  };
  return typeMap[aiExtract.value.type] || aiExtract.value.type;
});

const typeIcon = computed(() => {
  if (!aiExtract.value) return null;
  const iconMap = {
    auth_code: CodeRound,
    auth_link: LinkRound,
    service_link: LinkRound,
    subscription_link: LinkRound,
    other_link: LinkRound,
  };
  return iconMap[aiExtract.value.type] || CodeRound;
});

const isLink = computed(() => {
  return aiExtract.value && aiExtract.value.type !== 'auth_code';
});

const displayText = computed(() => {
  if (!aiExtract.value) return '';
  // For auth_code, always show the raw result (verification code)
  if (aiExtract.value.type === 'auth_code') {
    return aiExtract.value.result;
  }
  // For links, prefer result_text as display label
  return aiExtract.value.result_text || aiExtract.value.result;
});

const copyToClipboard = async () => {
  if (!aiExtract.value?.result) return;
  try {
    await navigator.clipboard.writeText(aiExtract.value.result);
    copied.value = true;
    message.success(t('copySuccess') || '已复制到剪贴板');
    setTimeout(() => { copied.value = false; }, 2000);
  } catch (e) {
    message.error(t('copyFailed') || '复制失败');
  }
};

const openLink = () => {
  if (isLink.value && aiExtract.value.result) {
    window.open(aiExtract.value.result, '_blank');
  }
};
</script>

<template>
  <div v-if="aiExtract && aiExtract.result" class="ai-extract-wrapper my-2 text-left">
    <!-- Compact Pill (used in mail list item) -->
    <div
      v-if="compact"
      @click.stop="copyToClipboard"
      class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium cursor-pointer transition-all bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20 hover:bg-emerald-500/20"
      :title="displayText"
    >
      <span>{{ aiExtract.type === 'auth_code' ? '🔑' : '🔗' }}</span>
      <span class="font-mono font-semibold">{{ displayText }}</span>
      <span class="text-[10px] opacity-75">{{ copied ? '✓' : '' }}</span>
    </div>

    <!-- Full AI Extracted Card (used in mail content view) -->
    <div
      v-else
      class="relative rounded-2xl border border-emerald-500/30 dark:border-emerald-500/20 bg-emerald-50/50 dark:bg-emerald-950/20 p-4 shadow-xs"
    >
      <div class="flex items-center justify-between flex-wrap gap-2 mb-2">
        <div class="flex items-center gap-2">
          <span class="flex items-center justify-center w-6 h-6 rounded-lg bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-xs">
            ✨
          </span>
          <span class="text-xs font-semibold text-emerald-900 dark:text-emerald-300 uppercase tracking-wide">
            {{ typeLabel }}
          </span>
        </div>
        <span v-if="aiExtract.type === 'auth_code'" class="text-[11px] text-emerald-600 dark:text-emerald-400">
          点击即可快速复制
        </span>
      </div>

      <div class="flex items-center justify-between flex-wrap gap-3 mt-2">
        <!-- Main Content -->
        <div class="flex items-center gap-3 min-w-0">
          <div
            v-if="aiExtract.type === 'auth_code'"
            class="px-4 py-2 rounded-xl bg-white dark:bg-zinc-900 border border-emerald-500/30 text-emerald-700 dark:text-emerald-300 font-mono font-bold text-2xl tracking-widest select-all shadow-inner"
          >
            {{ aiExtract.result }}
          </div>
          <div v-else class="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate max-w-lg">
            {{ displayText }}
          </div>
        </div>

        <!-- Action Buttons -->
        <div class="flex items-center gap-2 shrink-0">
          <button
            type="button"
            @click="copyToClipboard"
            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white text-xs font-medium shadow-xs transition-all cursor-pointer"
          >
            <span>{{ copied ? '✓' : '📋' }}</span>
            <span>{{ copied ? (t('copied') || '已复制') : (t('copy') || '复制') }}</span>
          </button>
          <button
            v-if="isLink"
            type="button"
            @click="openLink"
            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white dark:bg-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 text-xs font-medium shadow-xs transition-all cursor-pointer"
          >
            <span>↗</span>
            <span>{{ t('open') || '打开链接' }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
