<template>
  <div
    :class="[
      'inline-flex items-center justify-center gap-1 h-8 px-3 py-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800/80 border border-zinc-200/80 dark:border-zinc-700/80 select-none',
      className
    ]"
    role="status"
    :aria-label="isActive ? 'Audio active' : 'Audio idle'"
  >
    <span
      v-for="idx in barCount"
      :key="idx"
      :style="{
        animationDelay: `${((idx - 1) * 0.08) % 0.8}s`,
        animationDuration: `${0.6 + (((idx - 1) % 4) * 0.15)}s`
      }"
      :class="[
        'w-1 rounded-full transition-all duration-300',
        color,
        isActive
          ? 'h-full animate-[audio-pulse_0.8s_ease-in-out_infinite_alternate]'
          : 'h-1.5 opacity-40'
      ]"
    ></span>
  </div>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    isActive?: boolean;
    barCount?: number;
    color?: string;
    className?: string;
  }>(),
  {
    isActive: false,
    barCount: 16,
    color: 'bg-amber-500',
    className: ''
  }
);
</script>
