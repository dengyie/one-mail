<template>
  <div
    :class="[
      'my-2 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/80 shadow-sm overflow-hidden text-xs transition-all',
      className
    ]"
  >
    <button
      type="button"
      @click="isOpen = !isOpen"
      class="w-full flex items-center justify-between px-3.5 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors text-left select-none"
    >
      <div class="flex items-center gap-2.5">
        <div class="p-1 rounded-md bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300">
          🛠
        </div>
        <span class="font-mono font-medium text-zinc-800 dark:text-zinc-200">
          {{ name }}
        </span>
      </div>

      <div class="flex items-center gap-2">
        <span v-if="status === 'running'" class="flex items-center gap-1 text-amber-600 dark:text-amber-400 font-medium">
          <span class="animate-spin inline-block">⏳</span>
          <span>Running...</span>
        </span>
        <span v-if="status === 'success'" class="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium">
          <span>✓ Success</span>
        </span>
        <span v-if="status === 'error'" class="flex items-center gap-1 text-rose-600 dark:text-rose-400 font-medium">
          <span>✕ Failed</span>
        </span>

        <span :class="['text-[10px] text-zinc-400 transition-transform duration-200 inline-block', isOpen ? 'rotate-90' : '']">
          ▶
        </span>
      </div>
    </button>

    <!-- Drawer Content -->
    <div
      v-if="isOpen"
      class="px-3.5 py-2.5 border-t border-zinc-100 dark:border-zinc-800/80 bg-zinc-50/50 dark:bg-zinc-950/40 space-y-2 font-mono text-[11px]"
    >
      <div v-if="args">
        <div class="text-zinc-400 font-semibold mb-1">Arguments:</div>
        <pre class="p-2 rounded-lg bg-zinc-100 dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 overflow-x-auto m-0">{{ formattedArgs }}</pre>
      </div>

      <div v-if="output !== undefined">
        <div class="text-zinc-400 font-semibold mb-1">Output:</div>
        <pre class="p-2 rounded-lg bg-zinc-100 dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 overflow-x-auto max-h-48 m-0">{{ formattedOutput }}</pre>
      </div>

      <div v-if="error">
        <div class="text-rose-500 font-semibold mb-1">Error:</div>
        <pre class="p-2 rounded-lg bg-rose-50 dark:bg-rose-950/30 text-rose-600 dark:text-rose-400 overflow-x-auto m-0">{{ error }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';

const props = withDefaults(
  defineProps<{
    name: string;
    status: 'running' | 'success' | 'error';
    args?: Record<string, any> | string;
    output?: any;
    error?: string;
    className?: string;
  }>(),
  {
    className: ''
  }
);

const isOpen = ref(false);

const formattedArgs = computed(() => {
  return typeof props.args === 'object' ? JSON.stringify(props.args, null, 2) : props.args;
});

const formattedOutput = computed(() => {
  return typeof props.output === 'object' ? JSON.stringify(props.output, null, 2) : props.output;
});
</script>
