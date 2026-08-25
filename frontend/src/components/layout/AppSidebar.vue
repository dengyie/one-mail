<script setup>
import { ref, computed, h, onMounted } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useScopedI18n } from '@/i18n/app'
import {
  InboxFilled, PersonFilled, AdminPanelSettingsFilled,
  HomeFilled, SettingsFilled, LanguageFilled,
  ShieldFilled, MarkEmailReadFilled, CodeFilled
} from '@vicons/material'
import { GithubAlt } from '@vicons/fa'
import { useGlobalState } from '../../store'
import { api } from '../../api'
import { getRouterPathWithLang } from '../../utils'
import { SUPPORTED_LOCALES, getLocaleLabel } from '../../i18n/locale-registry'
import { isSupportedLocale, replaceLocaleInFullPath, DEFAULT_LOCALE } from '../../i18n/utils'
import ThemeToggle from '../ai/ThemeToggle.vue'
import StatusIndicator from '../ai/StatusIndicator.vue'

const props = defineProps({
  collapsed: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['update:collapsed', 'navigate'])

const route = useRoute()
const router = useRouter()
const { t, locale } = useScopedI18n('views.Header')

const {
  settings, userSettings, openSettings, showAdminPage,
  userJwt, jwt, adminAuth, preferredLocale, indexTab
} = useGlobalState()

const currentActive = computed(() => {
  if (route.path.includes('/unified')) return 'unified'
  if (route.path.includes('/admin')) return 'admin'
  if (route.path.includes('/user')) return 'user'
  return 'home'
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

const navItems = computed(() => [
  {
    key: 'home',
    label: t('home') || '收件箱',
    path: '/',
    icon: HomeFilled,
    badge: settings.value?.address ? 'Active' : null,
    badgeType: 'success'
  },
  {
    key: 'unified',
    label: t('unified') || '统一收件箱',
    path: '/unified',
    icon: InboxFilled,
    badge: 'Pro',
    badgeType: 'info'
  },
  {
    key: 'user',
    label: t('user') || '用户中心',
    path: '/user',
    icon: PersonFilled,
    badge: userSettings.value?.user_email ? userSettings.value.user_email.split('@')[0] : null,
    badgeType: 'neutral'
  },
  ...(showAdminPage.value ? [{
    key: 'admin',
    label: t('admin') || '系统管理',
    path: '/admin',
    icon: AdminPanelSettingsFilled,
    badge: 'Admin',
    badgeType: 'warning'
  }] : [])
])

const handleNavigate = (path) => {
  router.push(getRouterPathWithLang(path, locale.value))
  emit('navigate')
}
</script>

<template>
  <aside
    class="flex flex-col h-full bg-slate-900/95 dark:bg-slate-950/95 border-r border-slate-800/80 backdrop-blur-xl text-slate-200 transition-all duration-300 select-none"
    :class="collapsed ? 'w-[72px]' : 'w-64'"
  >
    <!-- Brand / Logo Area -->
    <div class="h-16 flex items-center px-4 gap-3 border-b border-slate-800/80">
      <img src="/logo.png" alt="MangoHub Logo" class="w-10 h-10 rounded-2xl object-cover shadow-lg shadow-blue-500/20 shrink-0" />
      <div v-if="!collapsed" class="flex flex-col min-w-0">
        <span class="font-bold text-base tracking-tight text-white truncate flex items-center gap-1.5">
          MangoHub Mail
          <span class="px-1.5 py-0.5 text-[10px] uppercase font-mono font-semibold bg-blue-500/20 text-blue-400 rounded-md border border-blue-500/30">AI</span>
        </span>
        <span class="text-xs text-slate-400 truncate">统一智能收件箱</span>
      </div>
    </div>

    <!-- Navigation Section -->
    <div class="flex-1 px-3 py-4 space-y-1.5 overflow-y-auto">
      <div v-if="!collapsed" class="px-3 pb-2 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
        核心导航
      </div>
      
      <button
        v-for="item in navItems"
        :key="item.key"
        @click="handleNavigate(item.path)"
        class="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-150 group relative"
        :class="currentActive === item.key
          ? 'bg-blue-600/15 text-blue-400 font-semibold border border-blue-500/30 shadow-xs'
          : 'text-slate-300 hover:text-white hover:bg-slate-800/60'"
        :title="collapsed ? item.label : undefined"
      >
        <n-icon size="20" :component="item.icon" class="shrink-0 transition-transform group-hover:scale-105" :class="currentActive === item.key ? 'text-blue-400' : 'text-slate-400 group-hover:text-slate-200'" />
        
        <span v-if="!collapsed" class="flex-1 text-left truncate">{{ item.label }}</span>
        
        <span
          v-if="!collapsed && item.badge"
          class="text-[10px] font-medium px-2 py-0.5 rounded-full border truncate max-w-[90px]"
          :class="{
            'bg-emerald-500/10 text-emerald-400 border-emerald-500/20': item.badgeType === 'success',
            'bg-blue-500/10 text-blue-400 border-blue-500/20': item.badgeType === 'info',
            'bg-amber-500/10 text-amber-400 border-amber-500/20': item.badgeType === 'warning',
            'bg-slate-800 text-slate-300 border-slate-700': item.badgeType === 'neutral',
          }"
        >
          {{ item.badge }}
        </span>

        <!-- Active Left Indicator Pill -->
        <div v-if="currentActive === item.key" class="absolute left-0 top-2 bottom-2 w-1 bg-blue-500 rounded-r-full"></div>
      </button>

      <!-- System Status Preview Card (Non-collapsed) -->
      <div v-if="!collapsed" class="pt-6">
        <div class="px-3 pb-2 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
          服务状态
        </div>
        <div class="p-3.5 rounded-2xl bg-slate-800/40 border border-slate-800/80 space-y-2.5">
          <div class="flex items-center justify-between text-xs">
            <span class="text-slate-400 flex items-center gap-1.5">
              <StatusIndicator status="online" size="sm" />
              API Worker
            </span>
            <span class="font-mono text-emerald-400 text-[11px]">Healthy</span>
          </div>
          <div class="flex items-center justify-between text-xs text-slate-400">
            <span>当前邮箱</span>
            <span class="font-mono text-slate-300 truncate max-w-[120px]" :title="settings?.address || '未生成'">
              {{ settings?.address ? settings.address.split('@')[0] : '未就绪' }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Bottom User Area (无需重复放语言/GitHub，仅保留用户信息) -->
    <div v-if="userSettings?.user_email" class="p-3 border-t border-slate-800/80">
      <div
        @click="handleNavigate('/user')"
        class="flex items-center gap-2.5 p-2 rounded-xl bg-slate-800/50 hover:bg-slate-800 cursor-pointer border border-slate-700/50 transition-all group"
        :class="collapsed ? 'justify-center p-2' : ''"
      >
        <div class="w-8 h-8 rounded-full bg-blue-600/30 border border-blue-500/40 text-blue-400 flex items-center justify-center font-bold text-xs uppercase shrink-0">
          {{ userSettings.user_email[0] }}
        </div>
        <div v-if="!collapsed" class="flex flex-col min-w-0 flex-1">
          <span class="text-xs font-semibold text-white truncate">{{ userSettings.user_email }}</span>
          <span class="text-[10px] text-slate-400 truncate">{{ userSettings.role || 'Member' }}</span>
        </div>
      </div>
    </div>
  </aside>
</template>
