<template>
  <div
    :class="[
      'inline-flex items-center p-0.5 rounded-xl bg-zinc-100 dark:bg-zinc-800/80 border border-zinc-200/80 dark:border-zinc-700/80 text-xs font-medium text-zinc-500 dark:text-zinc-400 select-none shadow-xs',
      className
    ]"
    role="group"
    aria-label="Theme toggle"
  >
    <button
      type="button"
      @click="applyTheme('auto')"
      :class="[
        'flex items-center gap-1.5 px-2.5 py-1 rounded-lg transition-all text-xs',
        mode === 'auto'
          ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-xs font-semibold'
          : 'hover:text-zinc-900 dark:hover:text-zinc-100'
      ]"
      title="Follow System/Time"
    >
      <span class="text-xs">💻</span>
      <span>Auto</span>
    </button>

    <button
      type="button"
      @click="applyTheme('light')"
      :class="[
        'flex items-center gap-1.5 px-2.5 py-1 rounded-lg transition-all text-xs',
        mode === 'light'
          ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-xs font-semibold'
          : 'hover:text-zinc-900 dark:hover:text-zinc-100'
      ]"
      title="Light Mode"
    >
      <span class="text-xs">☀️</span>
      <span>Light</span>
    </button>

    <button
      type="button"
      @click="applyTheme('dark')"
      :class="[
        'flex items-center gap-1.5 px-2.5 py-1 rounded-lg transition-all text-xs',
        mode === 'dark'
          ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-xs font-semibold'
          : 'hover:text-zinc-900 dark:hover:text-zinc-100'
      ]"
      title="Dark Mode"
    >
      <span class="text-xs">🌙</span>
      <span>Dark</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useGlobalState } from '../../store';

export type ThemeMode = 'auto' | 'light' | 'dark';

const props = withDefaults(
  defineProps<{
    storageKey?: string;
    className?: string;
  }>(),
  {
    storageKey: 'one-mail-theme-mode',
    className: ''
  }
);

const emit = defineEmits<{
  (e: 'change', mode: ThemeMode, resolved: 'light' | 'dark'): void;
}>();

const { isDark } = useGlobalState();
const mode = ref<ThemeMode>('auto');

const resolveTheme = (m: ThemeMode): 'light' | 'dark' => {
  if (m === 'light' || m === 'dark') return m;
  const isNight =
    (typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  return isNight ? 'dark' : 'light';
};

const applyTheme = (nextMode: ThemeMode) => {
  const resolved = resolveTheme(nextMode);
  document.documentElement.dataset.theme = nextMode;
  document.documentElement.dataset.resolvedTheme = resolved;
  document.documentElement.style.colorScheme = resolved;
  
  if (resolved === 'dark') {
    document.documentElement.classList.add('dark');
    isDark.value = true;
  } else {
    document.documentElement.classList.remove('dark');
    isDark.value = false;
  }
  
  mode.value = nextMode;
  try {
    localStorage.setItem(props.storageKey, nextMode);
  } catch {}
  emit('change', nextMode, resolved);
};

onMounted(() => {
  try {
    const saved = (localStorage.getItem(props.storageKey) as ThemeMode) || 'auto';
    applyTheme(saved);
  } catch {
    applyTheme('auto');
  }
  
  // Listen for system color-scheme changes if in auto mode
  if (typeof window !== 'undefined' && window.matchMedia) {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', () => {
      if (mode.value === 'auto') {
        applyTheme('auto');
      }
    });
  }
});
</script>

