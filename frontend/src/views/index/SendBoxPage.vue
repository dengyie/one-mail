<script setup>
import { onMounted, ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useScopedI18n } from '@/i18n/app'
import { useGlobalState } from '../../store'
import { api } from '../../api'
import { getRouterPathWithLang } from '../../utils'
import SendBox from '../../components/SendBox.vue'

const router = useRouter()
const { locale } = useScopedI18n('views.Header')
const { openSettings, settings, userJwt, jwt } = useGlobalState()
const initializing = ref(true)

const hasActiveAddress = computed(() => Boolean(settings.value?.address && jwt.value))

const deleteSenboxMail = async (curMailId) => {
  if (!jwt.value) return
  await api.fetch(`/api/sendbox/${curMailId}`, { method: 'DELETE' })
}

const fetchSenboxData = async (limit, offset) => {
  if (!jwt.value) {
    return { results: [], count: 0 }
  }
  try {
    return await api.fetch(`/api/sendbox?limit=${limit}&offset=${offset}`)
  } catch (error) {
    console.warn('fetch sendbox error:', error)
    return { results: [], count: 0 }
  }
}

onMounted(async () => {
  try {
    await api.getSettings()
  } finally {
    initializing.value = false
  }
})
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-xl font-bold text-slate-900 dark:text-white tracking-tight">已发邮件箱</h2>
        <p class="text-xs text-slate-500 dark:text-slate-400 mt-1">查看通过当前临时邮箱或外部发件服务已投递成功的历史邮件</p>
      </div>
      <div v-if="hasActiveAddress" class="px-3 py-1.5 rounded-xl bg-slate-200/60 dark:bg-slate-800/60 border border-slate-300/60 dark:border-slate-700/60 text-xs font-mono text-slate-700 dark:text-slate-300">
        发信地址: <span class="font-bold text-blue-600 dark:text-blue-400">{{ settings.address }}</span>
      </div>
    </div>

    <!-- 骨架屏加载状态 -->
    <div v-if="initializing" class="p-8 bg-white/90 dark:bg-slate-900/90 rounded-3xl border border-slate-200/80 dark:border-slate-800/80">
      <n-skeleton height="240px" class="rounded-2xl" />
    </div>

    <!-- 正常已发信箱面板 -->
    <div v-else-if="hasActiveAddress" class="bg-white/90 dark:bg-slate-900/90 backdrop-blur-xl rounded-3xl border border-slate-200/80 dark:border-slate-800/80 p-4 sm:p-6 shadow-sm">
      <SendBox
        :fetchMailData="fetchSenboxData"
        :enableUserDeleteEmail="openSettings.enableUserDeleteEmail"
        :deleteMail="deleteSenboxMail"
      />
    </div>

    <!-- 暂无激活发信邮箱的引导卡片 -->
    <div v-else class="bg-white/90 dark:bg-slate-900/90 backdrop-blur-xl rounded-3xl border border-slate-200/80 dark:border-slate-800/80 p-8 sm:p-12 text-center space-y-4 shadow-sm">
      <div class="w-16 h-16 mx-auto rounded-3xl bg-blue-500/10 dark:bg-blue-500/20 border border-blue-500/20 text-blue-600 dark:text-blue-400 flex items-center justify-center text-2xl font-bold">
        📮
      </div>
      <h3 class="text-lg font-bold text-slate-900 dark:text-white">暂未激活发信邮箱地址</h3>
      <p class="text-sm text-slate-500 dark:text-slate-400 max-w-md mx-auto">
        {{ userJwt ? '已发信箱需关联具体邮箱身份。请在「专属地址列表」中创建或选择一个邮箱地址后使用。' : '请先登录账号或在即时收件箱生成临时邮箱，以便记录和管理已发送的邮件。' }}
      </p>
      <div class="pt-3 flex justify-center gap-3">
        <n-button v-if="userJwt" @click="router.push(getRouterPathWithLang('/user/addresses', locale))" type="primary" class="rounded-xl font-medium px-5">
          前往专属地址列表
        </n-button>
        <n-button v-else @click="router.push(getRouterPathWithLang('/mailbox', locale))" type="primary" class="rounded-xl font-medium px-5">
          前往即时收件箱生成邮箱
        </n-button>
      </div>
    </div>
  </div>
</template>
