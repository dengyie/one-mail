<template>
  <div :class="['flex items-center gap-1 text-zinc-400 dark:text-zinc-500 text-xs mt-1.5 select-none', className]">
    <!-- Branch Navigator -->
    <div
      v-if="totalBranches && totalBranches > 1 && branchIndex !== undefined"
      class="flex items-center gap-0.5 mr-2 bg-zinc-100 dark:bg-zinc-800/80 px-1.5 py-0.5 rounded-md text-[11px] font-mono text-zinc-600 dark:text-zinc-400"
    >
      <button
        type="button"
        :disabled="branchIndex <= 0"
        @click="$emit('branchChange', branchIndex - 1)"
        class="hover:text-zinc-900 dark:hover:text-zinc-100 disabled:opacity-30 disabled:pointer-events-none p-0.5"
        title="Previous version"
      >
        <UiIcon name="chevron-left" :size="14" />
      </button>
      <span>{{ branchIndex + 1 }}/{{ totalBranches }}</span>
      <button
        type="button"
        :disabled="branchIndex >= totalBranches - 1"
        @click="$emit('branchChange', branchIndex + 1)"
        class="hover:text-zinc-900 dark:hover:text-zinc-100 disabled:opacity-30 disabled:pointer-events-none p-0.5"
        title="Next version"
      >
        <UiIcon name="chevron-right" :size="14" />
      </button>
    </div>

    <!-- Copy -->
    <button
      type="button"
      @click="handleCopy"
      class="p-1 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 rounded-md transition-colors"
      :title="copyFailed ? labels.copyFailed : (copied ? labels.copied : labels.copy)"
      :aria-label="copyFailed ? labels.copyFailed : (copied ? labels.copied : labels.copy)"
    >
      <UiIcon :name="copyFailed ? 'circle-x' : (copied ? 'check' : 'copy')" :size="16" />
    </button>

    <!-- Retry / Regenerate -->
    <button
      v-if="showRetry"
      type="button"
      @click="$emit('retry')"
      class="p-1 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 rounded-md transition-colors"
      :title="labels.retry"
      :aria-label="labels.retry"
    >
      <UiIcon name="refresh" :size="16" />
    </button>

    <!-- Thumbs Up / Down -->
    <template v-if="role === 'assistant' && showFeedback">
      <button
        type="button"
        @click="handleThumb('up')"
        :class="[
          'p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 rounded-md transition-colors',
          feedback === 'up' ? 'text-blue-500' : 'hover:text-zinc-700 dark:hover:text-zinc-200'
        ]"
        title="Good response"
      >
        <UiIcon name="thumbs-up" :size="16" />
      </button>
      <button
        type="button"
        @click="handleThumb('down')"
        :class="[
          'p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 rounded-md transition-colors',
          feedback === 'down' ? 'text-rose-500' : 'hover:text-zinc-700 dark:hover:text-zinc-200'
        ]"
        title="Bad response"
      >
        <UiIcon name="thumbs-down" :size="16" />
      </button>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import UiIcon from './UiIcon.vue';

const props = withDefaults(
  defineProps<{
    content: string;
    role?: 'assistant' | 'user' | string;
    showRetry?: boolean;
    showFeedback?: boolean;
    actionLabels?: Partial<Record<'copy' | 'copied' | 'copyFailed' | 'retry', string>>;
    branchIndex?: number;
    totalBranches?: number;
    className?: string;
  }>(),
  {
    role: 'assistant',
    showRetry: true,
    showFeedback: true,
    className: ''
  }
);

const emit = defineEmits<{
  (e: 'retry'): void;
  (e: 'feedback', type: 'up' | 'down'): void;
  (e: 'branchChange', index: number): void;
}>();

const copied = ref(false);
const copyFailed = ref(false);
const labels = computed(() => ({ copy: 'Copy', copied: 'Copied', copyFailed: 'Copy failed', retry: 'Regenerate', ...props.actionLabels }));
const feedback = ref<'up' | 'down' | null>(null);
let copyTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
onBeforeUnmount(() => { disposed = true; clearTimeout(copyTimer); });

const handleCopy = async () => {
  clearTimeout(copyTimer);
  copyFailed.value = false;
  try {
    await navigator.clipboard.writeText(props.content);
    if (disposed) return;
    copied.value = true;
  } catch {
    if (disposed) return;
    copied.value = false;
    copyFailed.value = true;
  }
  copyTimer = setTimeout(() => { copied.value = false; copyFailed.value = false; }, 2000);
};

const handleThumb = (type: 'up' | 'down') => {
  const next = feedback.value === type ? null : type;
  feedback.value = next;
  if (next) emit('feedback', next);
};
</script>
