<script setup>
import { computed, ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useScopedI18n } from '@/i18n/app'
import {
  InboxFilled, PersonFilled, AdminPanelSettingsFilled,
  HomeFilled, SettingsFilled, MarkEmailReadFilled,
  SendFilled, AddCircleOutlineFilled, ShieldFilled,
  VpnKeyFilled, PowerSettingsNewFilled, DynamicFeedFilled,
  AlternateEmailFilled, AutoAwesomeFilled
} from '@vicons/material'
import { GithubAlt } from '@vicons/fa'
import { useGlobalState } from '../../store'
import { api } from '../../api'
import { getRouterPathWithLang } from '../../utils'
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
  userJwt, jwt, adminAuth, preferredLocale, indexTab, userTab
} = useGlobalState()

const isLoggedIn = computed(() => Boolean(userJwt.value))

const handleNavigate = (path) => {
  router.push(getRouterPathWithLang(path, locale.value))
  emit('navigate')
}

const handleSwitchUserTab = (tabName) => {
  userTab.value = tabName
  router.push(getRouterPathWithLang('/user', locale.value))
  emit('navigate')
}

const handleSwitchIndexTab = (tabName) => {
  indexTab.value = tabName
  router.push(getRouterPathWithLang('/', locale.value))
  emit('navigate')
}

const handleLogout = () => {
  userJwt.value = ''
  userSettings.value = { fetched: true, user_email: '', user_id: 0, is_admin: false, access_token: null, user_role: null }
  router.push(getRouterPathWithLang('/', locale.value))
  emit('navigate')
}

// 登录后的侧边栏功能树
const activeKey = computed(() => {
  if (route.path.includes('/unified')) return 'unified'
  if (route.path.includes('/admin')) return 'admin'
  if (route.path.includes('/user')) {
    return `user_${userTab.value}`
  }
  return `index_${indexTab.value}`
})
</script>

<template>
  <aside
    class="flex flex-col h-full bg-slate-900/95 dark:bg-slate-950/95 border-r border-slate-800/80 backdrop-blur-xl text-slate-200 transition-all duration-300 select-none"
    :class="collapsed ? 'w-[72px]' : 'w-64'"
  >
    <!-- Brand / Logo Area -->
    <div class="h-16 flex items-center px-4 gap-3 border-b border-slate-800/80 cursor-pointer" @click="handleNavigate('/')">
      <img src="/logo.png" alt="MangoHub Logo" class="w-10 h-10 rounded-2xl object-cover shadow-lg shadow-blue-500/20 shrink-0" />
      <div v-if="!collapsed" class="flex flex-col min-w-0">
        <span class="font-bold text-base tracking-tight text-white truncate flex items-center gap-1.5">
          MangoHub Mail
          <span class="px-1.5 py-0.5 text-[10px] uppercase font-mono font-semibold bg-blue-500/20 text-blue-400 rounded-md border border-blue-500/30">AI</span>
        </span>
        <span class="text-xs text-slate-400 truncate">智能隐私收件工作台</span>
      </div>
    </div>

    <!-- Navigation Section (未登录状态仅展示精简入口，登录后展示完整功能树) -->
    <div class="flex-1 px-3 py-4 space-y-4 overflow-y-auto">
      
      <!-- 1. 未登录模式 -->
      <div v-if="!isLoggedIn" class="space-y-1.5">
        <button
          @click="handleNavigate('/')"
          class="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all"
          :class="route.path === '/' || route.path.endsWith('/') ? 'bg-blue-600/15 text-blue-400 font-semibold border border-blue-500/30' : 'text-slate-300 hover:text-white hover:bg-slate-800/60'"
        >
          <n-icon size="20" :component="HomeFilled" class="text-blue-400 shrink-0" />
          <span v-if="!collapsed">首页 · 账号登录</span>
        </button>
      </div>

      <!-- 2. 登录后的专属功能侧边栏 -->
      <div v-else class="space-y-4">
        <!-- 邮箱收发 -->
        <div class="space-y-1">
          <div v-if="!collapsed" class="px-3 pb-1 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
            邮箱工作台
          </div>
          
          <button
            @click="handleSwitchIndexTab('mailbox')"
            class="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-all"
            :class="activeKey === 'index_mailbox' ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30 font-semibold' : 'text-slate-300 hover:text-white hover:bg-slate-800/60'"
          >
            <n-icon size="18" :component="InboxFilled" class="shrink-0" />
            <span v-if="!collapsed" class="truncate">即时收件箱</span>
          </button>

          <button
            v-if="openSettings.enableSendMail"
            @click="handleSwitchIndexTab('sendmail')"
            class="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-all"
            :class="activeKey === 'index_sendmail' ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30 font-semibold' : 'text-slate-300 hover:text-white hover:bg-slate-800/60'"
          >
            <n-icon size="18" :component="SendFilled" class="shrink-0" />
            <span v-if="!collapsed" class="truncate">发送邮件</span>
          </button>

          <button
            @click="handleNavigate('/unified')"
            class="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-all"
            :class="activeKey === 'unified' ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30 font-semibold' : 'text-slate-300 hover:text-white hover:bg-slate-800/60'"
          >
            <n-icon size="18" :component="DynamicFeedFilled" class="shrink-0" />
            <span v-if="!collapsed" class="truncate flex items-center justify-between flex-1">
              <span>统一归集箱</span>
              <span class="px-1.5 py-0.2 text-[10px] bg-cyan-500/20 text-cyan-400 rounded-md font-mono">Pro</span>
            </span>
          </button>
        </div>

        <!-- 私人邮箱与地址管理 -->
        <div class="space-y-1">
          <div v-if="!collapsed" class="px-3 pb-1 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
            私人邮箱管理
          </div>

          <button
            @click="handleSwitchUserTab('address_management')"
            class="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-all"
            :class="activeKey === 'user_address_management' ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30 font-semibold' : 'text-slate-300 hover:text-white hover:bg-slate-800/60'"
          >
            <n-icon size="18" :component="AlternateEmailFilled" class="shrink-0" />
            <span v-if="!collapsed" class="truncate">专属地址列表</span>
          </button>

          <button
            @click="handleSwitchUserTab('user_mail_accounts')"
            class="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-all"
            :class="activeKey === 'user_user_mail_accounts' ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30 font-semibold' : 'text-slate-300 hover:text-white hover:bg-slate-800/60'"
          >
            <n-icon size="18" :component="AutoAwesomeFilled" class="shrink-0" />
            <span v-if="!collapsed" class="truncate">外部邮箱归集 (IMAP)</span>
          </button>

          <button
            @click="handleSwitchUserTab('user_settings')"
            class="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-all"
            :class="activeKey === 'user_user_settings' ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30 font-semibold' : 'text-slate-300 hover:text-white hover:bg-slate-800/60'"
          >
            <n-icon size="18" :component="SettingsFilled" class="shrink-0" />
            <span v-if="!collapsed" class="truncate">个人偏好与安全</span>
          </button>
        </div>

        <!-- 管理员后台 -->
        <div v-if="showAdminPage" class="space-y-1">
          <div v-if="!collapsed" class="px-3 pb-1 text-[11px] font-semibold text-amber-400/80 uppercase tracking-wider">
            系统管理
          </div>
          <button
            @click="handleNavigate('/admin')"
            class="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-all"
            :class="activeKey === 'admin' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 font-semibold' : 'text-slate-300 hover:text-white hover:bg-slate-800/60'"
          >
            <n-icon size="18" :component="AdminPanelSettingsFilled" class="text-amber-400 shrink-0" />
            <span v-if="!collapsed" class="truncate">管理员控制台</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Sidebar Footer / Account & Exit -->
    <div class="p-3 border-t border-slate-800/80">
      <div v-if="isLoggedIn && !collapsed" class="p-2.5 bg-slate-800/60 rounded-2xl border border-slate-700/60 flex items-center justify-between">
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="w-8 h-8 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 text-white flex items-center justify-center font-bold text-xs shadow-xs shrink-0">
            {{ (userSettings.user_email || 'U')[0].toUpperCase() }}
          </div>
          <div class="flex flex-col min-w-0">
            <span class="text-xs font-semibold text-white truncate">{{ userSettings.user_email || '已登录用户' }}</span>
            <span class="text-[10px] text-emerald-400 flex items-center gap-1 font-medium">
              <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
              在线
            </span>
          </div>
        </div>
        <button
          @click="handleLogout"
          title="退出登录"
          class="p-1.5 text-slate-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
        >
          <n-icon size="16" :component="PowerSettingsNewFilled" />
        </button>
      </div>

      <div v-else-if="isLoggedIn && collapsed" class="flex justify-center">
        <button
          @click="handleLogout"
          title="退出登录"
          class="p-2 text-slate-400 hover:text-red-400 hover:bg-red-500/10 rounded-xl transition-colors"
        >
          <n-icon size="20" :component="PowerSettingsNewFilled" />
        </button>
      </div>
    </div>
  </aside>
</template>
