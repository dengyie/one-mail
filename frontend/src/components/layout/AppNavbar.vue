<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useScopedI18n } from '@/i18n/app'
import {
  MenuFilled, MenuOpenFilled, SearchFilled, RefreshFilled,
  LanguageFilled, AdminPanelSettingsFilled, PersonFilled,
  HomeFilled, InboxFilled
} from '@vicons/material'
import { GithubAlt } from '@vicons/fa'
import { useGlobalState } from '../../store'
import { getRouterPathWithLang } from '../../utils'
import { SUPPORTED_LOCALES, getLocaleLabel } from '../../i18n/locale-registry'
import { isSupportedLocale, replaceLocaleInFullPath, DEFAULT_LOCALE } from '../../i18n/utils'
import ThemeToggle from '../ai/ThemeToggle.vue'
import StatusIndicator from '../ai/StatusIndicator.vue'

const props = defineProps({
  sidebarCollapsed: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['toggle-sidebar', 'open-mobile-menu'])

const route = useRoute()
const router = useRouter()
const { t, locale } = useScopedI18n('views.Header')

const {
  settings, userSettings, openSettings, showAdminPage,
  preferredLocale
} = useGlobalState()

const currentTitle = computed(() => {
  if (route.path.includes('/unified')) return t('unified') || '统一收件箱'
  if (route.path.includes('/admin')) return t('admin') || '系统管理'
  if (route.path.includes('/user')) return t('user') || '用户中心'
  return t('home') || '收件箱'
})

const languageOptions = SUPPORTED_LOCALES.map((loc) => ({
  label: getLocaleLabel(loc),
  key: loc,
}))

const changeLocale = async (lang) => {
  if (!isSupportedLocale(lang)) return
  const currentFullPath = route.fullPath
  const targetFullPath = replaceLocaleInFullPath(currentFullPath, lang)
  if (lang === DEFAULT_LOCALE) preferredLocale.value = DEFAULT_LOCALE
  await router.push(targetFullPath)
  preferredLocale.value = lang
}

const showGithub = computed(() => {
  if (!openSettings.value.showGithub) return false
  if (openSettings.value.showGithubForUser) return true
  return showAdminPage.value
})

const navTo = (path) => {
  router.push(getRouterPathWithLang(path, locale.value))
}
</script>

<template>
  <header class="h-16 sticky top-0 z-30 flex items-center justify-between px-4 sm:px-6 bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl border-b border-slate-200/80 dark:border-slate-800/80 transition-colors">
    <!-- Left: Collapse toggle + Page Title -->
    <div class="flex items-center gap-3">
      <!-- Desktop collapse toggle -->
      <button
        @click="emit('toggle-sidebar')"
        class="hidden md:flex items-center justify-center w-9 h-9 rounded-xl text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800/80 transition-colors"
        :title="sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'"
      >
        <n-icon size="20" :component="sidebarCollapsed ? MenuFilled : MenuOpenFilled" />
      </button>

      <!-- Mobile hamburger -->
      <button
        @click="emit('open-mobile-menu')"
        :aria-label="t('menu') || 'Menu'"
        class="md:hidden flex items-center justify-center w-9 h-9 rounded-xl text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800/80 transition-colors"
      >
        <n-icon size="20" :component="MenuFilled" />
      </button>

      <div class="flex items-center gap-2.5">
        <h1 class="text-lg font-bold text-slate-900 dark:text-white tracking-tight">
          {{ currentTitle }}
        </h1>
        <StatusIndicator status="online" size="sm" class="hidden sm:inline-flex" />
      </div>
    </div>

    <!-- Right: Quick actions, Theme, Lang, User info -->
    <div class="flex items-center gap-2">
      <!-- Address pill (if generated) -->
      <div
        v-if="settings?.address"
        class="hidden sm:flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/60 text-xs font-mono text-slate-700 dark:text-slate-300"
      >
        <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
        <span class="truncate max-w-[160px]">{{ settings.address }}</span>
      </div>

      <!-- Theme Switcher -->
      <div class="hidden sm:block">
        <ThemeToggle />
      </div>

      <!-- Language Selector -->
      <n-dropdown :options="languageOptions" @select="changeLocale" trigger="click">
        <button
          :aria-label="t('switchLanguage') || 'Change language'"
          class="p-2 rounded-xl text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          title="切换语言"
        >
          <n-icon size="18" :component="LanguageFilled" />
        </button>
      </n-dropdown>

      <!-- GitHub -->
      <a
        v-if="showGithub"
        href="https://github.com/dengyie/one-mail"
        target="_blank"
        class="p-2 rounded-xl text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
        title="GitHub"
      >
        <n-icon size="18" :component="GithubAlt" />
      </a>

      <!-- User avatar / Login button -->
      <button
        v-if="userSettings?.user_email"
        @click="navTo('/user')"
        class="flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-xl bg-blue-50 dark:bg-blue-950/50 hover:bg-blue-100 dark:hover:bg-blue-900/50 border border-blue-200/60 dark:border-blue-800/60 text-blue-600 dark:text-blue-400 text-xs font-semibold transition-colors"
      >
        <div class="w-6 h-6 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold text-[10px] uppercase">
          {{ userSettings.user_email[0] }}
        </div>
        <span class="max-w-[100px] truncate hidden md:inline">{{ userSettings.user_email }}</span>
      </button>

      <button
        v-else
        @click="navTo('/user')"
        class="px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-xs transition-colors"
      >
        {{ t('userLogin') || '登录 / 注册' }}
      </button>
    </div>
  </header>
</template>
