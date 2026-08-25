<template>
  <div v-if="suggestions && suggestions.length > 0" :class="['flex flex-wrap gap-2 my-3', className]">
    <button
      v-for="(item, idx) in suggestions"
      :key="idx"
      type="button"
      @click="$emit('select', item)"
      class="group flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-full border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 shadow-xs hover:border-zinc-300 dark:hover:border-zinc-700 transition-all text-left"
    >
      <span class="text-amber-500/70 group-hover:text-amber-500 transition-colors">✨</span>
      <span class="truncate max-w-[280px]">{{ item }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    suggestions: string[];
    className?: string;
  }>(),
  {
    className: ''
  }
);

defineEmits<{
  (e: 'select', prompt: string): void;
}>();
</script>
