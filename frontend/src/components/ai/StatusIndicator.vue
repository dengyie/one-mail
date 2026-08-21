<template>
  <div
    :class="[
      'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium',
      config.badgeBg,
      config.text,
      className
    ]"
  >
    <span v-if="showDot" class="relative flex h-2 w-2">
      <span
        v-if="status === 'online'"
        :class="['animate-ping absolute inline-flex h-full w-full rounded-full opacity-75', config.pingBg]"
      ></span>
      <span :class="['relative inline-flex rounded-full h-2 w-2', config.dotBg]"></span>
    </span>
    <span class="font-semibold">{{ label || config.defaultLabel }}</span>
    <span v-if="pingMs !== undefined" class="font-mono text-[10px] opacity-75 ml-0.5">
      ({{ pingMs }}ms)
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

export type StatusType = 'online' | 'offline' | 'busy' | 'connecting' | 'error';

const props = withDefaults(
  defineProps<{
    status: StatusType;
    label?: string;
    pingMs?: number;
    showDot?: boolean;
    className?: string;
  }>(),
  {
    showDot: true,
    className: ''
  }
);

const config = computed(() => {
  switch (props.status) {
    case 'online':
      return {
        dotBg: 'bg-emerald-500',
        pingBg: 'bg-emerald-400',
        text: 'text-emerald-700 dark:text-emerald-400',
        badgeBg: 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200/80 dark:border-emerald-800/60',
        defaultLabel: 'Online'
      };
    case 'connecting':
    case 'busy':
      return {
        dotBg: 'bg-amber-500',
        pingBg: 'bg-amber-400',
        text: 'text-amber-700 dark:text-amber-400',
        badgeBg: 'bg-amber-50 dark:bg-amber-950/40 border-amber-200/80 dark:border-amber-800/60',
        defaultLabel: props.status === 'busy' ? 'Busy' : 'Connecting'
      };
    case 'error':
    case 'offline':
    default:
      return {
        dotBg: 'bg-rose-500',
        pingBg: 'bg-rose-400',
        text: 'text-rose-700 dark:text-rose-400',
        badgeBg: 'bg-rose-50 dark:bg-rose-950/40 border-rose-200/80 dark:border-rose-800/60',
        defaultLabel: props.status === 'error' ? 'Error' : 'Offline'
      };
  }
});
</script>
