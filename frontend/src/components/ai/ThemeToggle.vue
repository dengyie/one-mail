<script setup lang="ts">
import { watch } from 'vue'
import { useStorage, usePreferredDark } from '@vueuse/core'
import { useGlobalState } from '../../store'
import { useScopedI18n } from '../../i18n/app'
import UiIcon from './UiIcon.vue'

export type ThemeMode = 'auto' | 'light' | 'dark'
const props = withDefaults(defineProps<{ storageKey?: string; className?: string }>(), {
  storageKey: 'one-mail-theme-mode', className: '',
})
const emit = defineEmits<{ (e: 'change', mode: ThemeMode, resolved: 'light' | 'dark'): void }>()
const { isDark } = useGlobalState()
const { t } = useScopedI18n('workspace')
const mode = useStorage<ThemeMode>(props.storageKey, 'auto')
const prefersDark = usePreferredDark()
const modes = [
  { value: 'auto', icon: 'monitor', label: 'themeAuto' },
  { value: 'light', icon: 'sun', label: 'themeLight' },
  { value: 'dark', icon: 'moon', label: 'themeDark' },
] as const

watch([mode, prefersDark], ([current, systemDark]) => {
  if (!modes.some(item => item.value === current)) { mode.value = 'auto'; return }
  const dark = current === 'dark' || (current === 'auto' && systemDark)
  isDark.value = dark
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = current
    document.documentElement.dataset.resolvedTheme = dark ? 'dark' : 'light'
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  }
  emit('change', current, dark ? 'dark' : 'light')
}, { immediate: true })
</script>

<template>
  <div class="theme-toggle" :class="className" role="group" :aria-label="t('theme')">
    <button v-for="item in modes" :key="item.value" type="button" :title="t(item.label)" :aria-label="t(item.label)" :aria-pressed="mode === item.value" @click="mode = item.value">
      <UiIcon :name="item.icon" :size="15" />
    </button>
  </div>
</template>
