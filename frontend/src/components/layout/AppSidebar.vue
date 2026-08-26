<script setup>
import { computed, ref, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useScopedI18n } from '@/i18n/app'
import {
  InboxFilled, PersonFilled, AdminPanelSettingsFilled,
  HomeFilled, SettingsFilled, MarkEmailReadFilled,
  SendFilled, AddCircleOutlineFilled, ShieldFilled,
  VpnKeyFilled, PowerSettingsNewFilled, DynamicFeedFilled,
  AlternateEmailFilled, AutoAwesomeFilled,
  GroupFilled, ManageAccountsFilled, DnsFilled,
  BarChartFilled, HubFilled, SecurityFilled, PsychologyFilled,
  CleaningServicesFilled, StorageFilled, PaletteFilled,
  SendAndArchiveFilled
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
  userJwt, jwt, adminAuth, preferredLocale, indexTab, userTab, adminTab
} = useGlobalState()

const isLoggedIn = computed(() => Boolean(userJwt.value))

const handleNavigate = (path) => {
  router.push(getRouterPathWithLang(path, locale.value))
  emit('navigate')
}

const handleLogout = () => {
  userJwt.value = ''
  userSettings.value = { fetched: true, user_email: '', user_id: 0, is_admin: false, access_token: null, user_role: null }
  router.push(getRouterPathWithLang('/', locale.value))
  emit('navigate')
}

// 侧边栏高亮定位（严格匹配 URL 路由路径）
const activeRoute = computed(() => {
  const p = route.path
  if (p.includes('/admin/users')) return 'admin_users'
  if (p.includes('/admin/statistics')) return 'admin_statistics'
  if (p.includes('/admin/ai-extract')) return 'admin_ai_extract'
  if (p.includes('/admin/webhook')) return 'admin_webhook'
  if (p.includes('/admin/database')) return 'admin_database'
  if (p.includes('/admin/settings')) return 'admin_settings'
  if (p.includes('/admin/accounts') || p.endsWith('/admin')) return 'admin_accounts'
  
  if (p.includes('/unified')) return 'unified'
  if (p.includes('/sendmail')) return 'sendmail'
  if (p.includes('/sendbox')) return 'sendbox'
  
  if (p.includes('/user/addresses')) return 'user_addresses'
  if (p.includes('/user/external-accounts')) return 'user_external'
  if (p.includes('/user/settings')) return 'user_settings'
  if (p.includes('/user/appearance')) return 'user_appearance'
  if (p.includes('/user')) return 'user_addresses'
  return 'mailbox'
})
</script>

<template>
  <aside
    class="flex flex-col h-full bg-slate-900/95 dark:bg-slate-950/95 border-r border-slate-800/80 backdrop-blur-xl text-slate-200 transition-all duration-300 select-none"
    :class="collapsed ? 'w-[72px]' : 'w-64'"
  >
    <!-- Brand / Logo Area -->
    <div class="h-16 flex items-center px-4 gap-3 border-b border-slate-800/80 cursor-pointer shrink-0" @click="handleNavigate('/')">
      <img src="/logo.png" alt="MangoHub Logo" class="w-10 h-10 rounded-2xl object-cover shadow-lg shadow-blue-500/20 shrink-0" />
      <div v-if="!collapsed" class="flex flex-col min-w-0">
        <span class="font-bold text-base tracking-tight text-white truncate flex items-center gap-1.5">
          MangoHub Mail
          <span class="px-1.5 py-0.5 text-[10px] uppercase font-mono font-semibold bg-blue-500/20 text-blue-400 rounded-md border border-blue-500/30">AI</span>
        </span>
        <span class="text-xs text-slate-400 truncate">智能隐私收件工作台</span>
      </div>
    </div>

    <!-- Navigation Section -->
    <div class="flex-1 px-3 py-4 space-y-5 overflow-y-auto overflow-x-hidden">
      
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
      <div v-else class="space-y-5">
        
        <!-- 模块一：邮箱工作台 -->
        <div class="space-y-1">
          <div v-if="!collapsed" class="px-3 pb-1 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
            邮箱工作台
          </div>
          
          <button
            @click="handleNavigate('/mailbox')"
            class="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-all"
            :class="activeRoute === 'mailbox' ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30 font-semibold' : 'text-slate-300 hover:text-white hover:bg-slate-800/60'"
          >
            <n-icon size="18" :component="InboxFilled" class="shrink-0" />
            <span v-if="!collapsed" class="truncate">即时收件箱</span>
          </button>

          <button
            v-if="openSettings.enableSendMail"
            @click="handleNavigate('/sendmail')"
            class="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-all"
            :class="activeRoute === 'sendmail' ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30 font-semibold' : 'text-slate-300 hover:text-white hover:bg-slate-800/60'"
          >
            <n-icon size="18" :component="SendFilled" class="shrink-0" />
            <span v-if="!collapsed" class="truncate">发送邮件</span>
          </button>

          <button
            v-if="openSettings.enableSendMail"
            @click="handleNavigate('/sendbox')"
            class="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-all"
            :class="activeRoute === 'sendbox' ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30 font-semibold' : 'text-slate-300 hover:text-white hover:bg-slate-800/60'"
          >
            <n-icon size="18" :component="SendAndArchiveFilled" class="shrink-0" />
            <span v-if="!collapsed" class="truncate">已发信箱</span>
          </button>

          <button
            @click="handleNavigate('/unified')"
            class="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-all"
            :class="activeRoute === 'unified' ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30 font-semibold' : 'text-slate-300 hover:text-white hover:bg-slate-800/60'"
          >
            <n-icon size="18" :component="DynamicFeedFilled" class="shrink-0" />
            <span v-if="!collapsed" class="truncate flex items-center justify-between flex-1">
              <span>统一归集箱</span>
              <span class="px-1.5 py-0.2 text-[10px] bg-cyan-500/20 text-cyan-400 rounded-md font-mono">Pro</span>
            </span>
          </button>
        </div>

        <!-- 模块二：私人邮箱与安全 -->
        <div class="space-y-1">
          <div v-if="!collapsed" class="px-3 pb-1 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
            私人邮箱管理
          </div>

          <button
            @click="handleNavigate('/user/addresses')"
            class="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-all"
            :class="activeRoute === 'user_addresses' ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30 font-semibold' : 'text-slate-300 hover:text-white hover:bg-slate-800/60'"
          >
            <n-icon size="18" :component="AlternateEmailFilled" class="shrink-0" />
            <span v-if="!collapsed" class="truncate">专属地址列表</span>
          </button>

          <button
            @click="handleNavigate('/user/external-accounts')"
            class="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-all"
            :class="activeRoute === 'user_external' ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30 font-semibold' : 'text-slate-300 hover:text-white hover:bg-slate-800/60'"
          >
            <n-icon size="18" :component="AutoAwesomeFilled" class="shrink-0" />
            <span v-if="!collapsed" class="truncate">外部邮箱归集 (IMAP)</span>
          </button>

          <button
            @click="handleNavigate('/user/settings')"
            class="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-all"
            :class="activeRoute === 'user_settings' ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30 font-semibold' : 'text-slate-300 hover:text-white hover:bg-slate-800/60'"
          >
            <n-icon size="18" :component="SettingsFilled" class="shrink-0" />
            <span v-if="!collapsed" class="truncate">个人偏好与安全</span>
          </button>

          <button
            @click="handleNavigate('/user/appearance')"
            class="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-all"
            :class="activeRoute === 'user_appearance' ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30 font-semibold' : 'text-slate-300 hover:text-white hover:bg-slate-800/60'"
          >
            <n-icon size="18" :component="PaletteFilled" class="shrink-0" />
            <span v-if="!collapsed" class="truncate">外观与布局个性化</span>
          </button>
        </div>

        <!-- 模块三：管理员运维后台 (严格按独立子 URL 路由跳转) -->
        <div v-if="showAdminPage" class="space-y-1">
          <div v-if="!collapsed" class="px-3 pb-1 text-[11px] font-semibold text-amber-400/80 uppercase tracking-wider">
            系统管理中心
          </div>

          <button
            @click="handleNavigate('/admin/accounts')"
            class="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-all"
            :class="activeRoute === 'admin_accounts' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 font-semibold' : 'text-slate-300 hover:text-white hover:bg-slate-800/60'"
          >
            <n-icon size="18" :component="ManageAccountsFilled" class="text-amber-400 shrink-0" />
            <span v-if="!collapsed" class="truncate">邮箱账户管理</span>
          </button>

          <button
            @click="handleNavigate('/admin/users')"
            class="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-all"
            :class="activeRoute === 'admin_users' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 font-semibold' : 'text-slate-300 hover:text-white hover:bg-slate-800/60'"
          >
            <n-icon size="18" :component="GroupFilled" class="text-amber-400 shrink-0" />
            <span v-if="!collapsed" class="truncate">注册用户列表</span>
          </button>

          <button
            @click="handleNavigate('/admin/statistics')"
            class="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-all"
            :class="activeRoute === 'admin_statistics' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 font-semibold' : 'text-slate-300 hover:text-white hover:bg-slate-800/60'"
          >
            <n-icon size="18" :component="BarChartFilled" class="text-amber-400 shrink-0" />
            <span v-if="!collapsed" class="truncate">业务统计看板</span>
          </button>

          <button
            @click="handleNavigate('/admin/ai-extract')"
            class="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-all"
            :class="activeRoute === 'admin_ai_extract' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 font-semibold' : 'text-slate-300 hover:text-white hover:bg-slate-800/60'"
          >
            <n-icon size="18" :component="PsychologyFilled" class="text-amber-400 shrink-0" />
            <span v-if="!collapsed" class="truncate">AI 提取策略配置</span>
          </button>

          <button
            @click="handleNavigate('/admin/webhook')"
            class="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-all"
            :class="activeRoute === 'admin_webhook' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 font-semibold' : 'text-slate-300 hover:text-white hover:bg-slate-800/60'"
          >
            <n-icon size="18" :component="HubFilled" class="text-amber-400 shrink-0" />
            <span v-if="!collapsed" class="truncate">Webhook 推送配置</span>
          </button>

          <button
            @click="handleNavigate('/admin/database')"
            class="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-all"
            :class="activeRoute === 'admin_database' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 font-semibold' : 'text-slate-300 hover:text-white hover:bg-slate-800/60'"
          >
            <n-icon size="18" :component="StorageFilled" class="text-amber-400 shrink-0" />
            <span v-if="!collapsed" class="truncate">数据库结构与维护</span>
          </button>

          <button
            @click="handleNavigate('/admin/settings')"
            class="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-all"
            :class="activeRoute === 'admin_settings' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 font-semibold' : 'text-slate-300 hover:text-white hover:bg-slate-800/60'"
          >
            <n-icon size="18" :component="DnsFilled" class="text-amber-400 shrink-0" />
            <span v-if="!collapsed" class="truncate">域名与全局策略</span>
          </button>
        </div>

      </div>
    </div>

    <!-- User Profile & Logout Bottom Card -->
    <div class="p-3 border-t border-slate-800/80 bg-slate-950/40 shrink-0">
      <div v-if="isLoggedIn" class="flex items-center justify-between p-2 rounded-2xl bg-slate-800/50 border border-slate-700/50">
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="w-8 h-8 rounded-xl bg-blue-600/30 border border-blue-500/40 text-blue-400 flex items-center justify-center font-bold text-xs shrink-0">
            {{ userSettings.user_email?.[0]?.toUpperCase() || 'U' }}
          </div>
          <div v-if="!collapsed" class="flex flex-col min-w-0">
            <span class="text-xs font-semibold text-white truncate max-w-[110px]">
              {{ userSettings.user_email }}
            </span>
            <span class="text-[10px] text-slate-400 truncate">{{ userSettings.is_admin ? '系统管理员' : '已认证用户' }}</span>
          </div>
        </div>

        <button
          @click="handleLogout"
          class="p-1.5 rounded-xl text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
          title="退出登录"
        >
          <n-icon size="18" :component="PowerSettingsNewFilled" />
        </button>
      </div>

      <div v-else class="text-center py-1">
        <span v-if="!collapsed" class="text-[11px] text-slate-400">请登录使用全功能收件箱</span>
      </div>
    </div>
  </aside>
</template>
