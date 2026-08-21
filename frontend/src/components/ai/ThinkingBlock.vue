<template>
  <div
    v-if="content || isThinking"
    :class="[
      'my-3 rounded-xl border border-zinc-200/80 dark:border-zinc-800/80 bg-zinc-50/50 dark:bg-zinc-900/40 text-xs overflow-hidden transition-all',
      className
    ]"
  >
    <!-- Header Bar -->
    <button
      type="button"
      @click="isExpanded = !isExpanded"
      class="w-full flex items-center justify-between px-3.5 py-2.5 hover:bg-zinc-100/50 dark:hover:bg-zinc-800/40 text-zinc-500 dark:text-zinc-400 font-medium transition-colors select-none text-left"
    >
      <div class="flex items-center gap-2">
        <span :class="['w-3.5 h-3.5 inline-block', isThinking ? 'text-amber-500 animate-spin' : 'text-zinc-400']">
          ✨
        </span>
        <span>
          {{ isThinking ? 'Deeply thinking...' : durationSeconds ? `Thought for ${durationSeconds}s` : 'Thought process' }}
        </span>
      </div>
      <span :class="['text-[10px] text-zinc-400 transition-transform duration-200', isExpanded ? 'rotate-180' : '']">
        ▼
      </span>
    </button>

    <!-- Content -->
    <div
      v-if="isExpanded"
      class="px-4 py-3 border-t border-zinc-200/50 dark:border-zinc-800/50 text-zinc-600 dark:text-zinc-400 leading-relaxed font-mono whitespace-pre-wrap text-[13px] bg-white/40 dark:bg-zinc-950/20"
    >
      <span v-if="!content" class="italic text-zinc-400">Processing thoughts...</span>
      <span v-else>{{ content }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const props = withDefaults(
  defineProps<{
    content: string;
    isThinking?: boolean;
    durationSeconds?: number;
    defaultExpanded?: boolean;
    className?: string;
  }>(),
  {
    isThinking: false,
    defaultExpanded: false,
    className: ''
  }
);

const isExpanded = ref(props.defaultExpanded || props.isThinking);
</script>
