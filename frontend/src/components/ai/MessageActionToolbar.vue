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
        ‹
      </button>
      <span>{{ branchIndex + 1 }}/{{ totalBranches }}</span>
      <button
        type="button"
        :disabled="branchIndex >= totalBranches - 1"
        @click="$emit('branchChange', branchIndex + 1)"
        class="hover:text-zinc-900 dark:hover:text-zinc-100 disabled:opacity-30 disabled:pointer-events-none p-0.5"
        title="Next version"
      >
        ›
      </button>
    </div>

    <!-- Copy -->
    <button
      type="button"
      @click="handleCopy"
      class="p-1 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 rounded-md transition-colors"
      title="Copy response"
    >
      <span v-if="copied" class="text-emerald-500 font-bold">✓</span>
      <span v-else>📋</span>
    </button>

    <!-- Retry / Regenerate -->
    <button
      v-if="showRetry"
      type="button"
      @click="$emit('retry')"
      class="p-1 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 rounded-md transition-colors"
      title="Regenerate response"
    >
      🔄
    </button>

    <!-- Thumbs Up / Down -->
    <template v-if="role === 'assistant'">
      <button
        type="button"
        @click="handleThumb('up')"
        :class="[
          'p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 rounded-md transition-colors',
          feedback === 'up' ? 'text-blue-500' : 'hover:text-zinc-700 dark:hover:text-zinc-200'
        ]"
        title="Good response"
      >
        👍
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
        👎
      </button>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const props = withDefaults(
  defineProps<{
    content: string;
    role?: 'assistant' | 'user' | string;
    showRetry?: boolean;
    branchIndex?: number;
    totalBranches?: number;
    className?: string;
  }>(),
  {
    role: 'assistant',
    showRetry: true,
    className: ''
  }
);

const emit = defineEmits<{
  (e: 'retry'): void;
  (e: 'feedback', type: 'up' | 'down'): void;
  (e: 'branchChange', index: number): void;
}>();

const copied = ref(false);
const feedback = ref<'up' | 'down' | null>(null);

const handleCopy = async () => {
  await navigator.clipboard.writeText(props.content);
  copied.value = true;
  setTimeout(() => (copied.value = false), 2000);
};

const handleThumb = (type: 'up' | 'down') => {
  const next = feedback.value === type ? null : type;
  feedback.value = next;
  if (next) emit('feedback', next);
};
</script>
