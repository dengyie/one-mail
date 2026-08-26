<script setup>
import { useGlobalState } from '../../store'
import { api } from '../../api'
import SendBox from '../../components/SendBox.vue'

const { openSettings } = useGlobalState()

const deleteSenboxMail = async (curMailId) => {
  await api.fetch(`/api/sendbox/${curMailId}`, { method: 'DELETE' })
}

const fetchSenboxData = async (limit, offset) => {
  return await api.fetch(`/api/sendbox?limit=${limit}&offset=${offset}`)
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-xl font-bold text-slate-900 dark:text-white tracking-tight">已发邮件箱</h2>
        <p class="text-xs text-slate-500 dark:text-slate-400 mt-1">查看通过当前临时邮箱或外部发件服务已投递成功的历史邮件</p>
      </div>
    </div>

    <div class="bg-white/90 dark:bg-slate-900/90 backdrop-blur-xl rounded-3xl border border-slate-200/80 dark:border-slate-800/80 p-4 sm:p-6 shadow-sm">
      <SendBox
        :fetchMailData="fetchSenboxData"
        :enableUserDeleteEmail="openSettings.enableUserDeleteEmail"
        :deleteMail="deleteSenboxMail"
      />
    </div>
  </div>
</template>
