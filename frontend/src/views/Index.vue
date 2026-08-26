<script setup>
import { defineAsyncComponent, onMounted, watch, ref, computed } from 'vue'
import { useMessage } from 'naive-ui'
import { useScopedI18n } from '@/i18n/app'
import { useRoute, useRouter } from 'vue-router'

import { useGlobalState } from '../store'
import { api } from '../api'
import { useIsMobile } from '../utils/composables'
import { FullscreenExitOutlined } from '@vicons/material'
import { getRouterPathWithLang } from '../utils'

import UserLogin from './user/UserLogin.vue'
import AddressBar from './index/AddressBar.vue'
import MailBox from '../components/MailBox.vue'
import SendBox from '../components/SendBox.vue'
import SimpleIndex from './index/SimpleIndex.vue'

const {
  loading, settings, openSettings, indexTab,
  globalTabplacement, useSimpleIndex, userJwt, userSettings
} = useGlobalState()

const message = useMessage()
const route = useRoute()
const router = useRouter()
const isMobile = useIsMobile()

const isLoggedIn = computed(() => Boolean(userJwt.value))

const SendMail = defineAsyncComponent(() => {
  loading.value = true
  return import('./index/SendMail.vue')
    .finally(() => loading.value = false)
})

const { t, locale } = useScopedI18n('views.Index')

const fetchMailData = async (limit, offset) => {
  if (mailIdQuery.value > 0) {
    const singleMail = await api.fetch(`/api/mail/${mailIdQuery.value}`)
    if (singleMail) return { results: [singleMail], count: 1 }
    return { results: [], count: 0 }
  }
  return await api.fetch(`/api/mails?limit=${limit}&offset=${offset}`)
}

const deleteMail = async (curMailId) => {
  await api.fetch(`/api/mails/${curMailId}`, { method: 'DELETE' })
}

const deleteSenboxMail = async (curMailId) => {
  await api.fetch(`/api/sendbox/${curMailId}`, { method: 'DELETE' })
}

const fetchSenboxData = async (limit, offset) => {
  return await api.fetch(`/api/sendbox?limit=${limit}&offset=${offset}`)
}

const saveToS3 = async (mail_id, filename, blob) => {
  try {
    const { url } = await api.fetch(`/api/attachment/put_url`, {
      method: 'POST',
      body: JSON.stringify({ key: `${mail_id}/${filename}` })
    })
    const formData = new FormData()
    formData.append(filename, blob)
    await fetch(url, {
      method: 'PUT',
      body: formData
    })
    message.success(t('saveToS3Success'))
  } catch (error) {
    console.error(error)
    message.error(error.message || 'save to s3 error')
  }
}

const mailBoxKey = ref('')
const mailIdQuery = ref('')
const showMailIdQuery = ref(false)

const queryMail = () => {
  mailBoxKey.value = Date.now()
}

watch(route, () => {
  if (!route.query.mail_id) {
    showMailIdQuery.value = false
    mailIdQuery.value = ''
    queryMail()
  }
})

onMounted(async () => {
  if (route.query.mail_id) {
    showMailIdQuery.value = true
    mailIdQuery.value = route.query.mail_id
    queryMail()
  }
})
</script>

<template>
  <div class="space-y-6">
    <!-- 1. 未登录状态：展示全功能 Hero 宣传与登录/注册门户 (仿照 tfm.memom.mom) -->
    <div v-if="!isLoggedIn">
      <UserLogin />
    </div>

    <!-- 2. 已登录状态：展示邮箱工作台 -->
    <div v-else class="space-y-6">
      <div v-if="useSimpleIndex">
        <SimpleIndex />
      </div>
      <div v-else class="space-y-6">
        <AddressBar />
        <div v-if="settings.address" class="space-y-4">
          <!-- Direct MailBox View -->
          <div class="bg-white/90 dark:bg-slate-900/90 backdrop-blur-xl rounded-3xl border border-slate-200/80 dark:border-slate-800/80 p-4 sm:p-6 shadow-sm">
            <div class="flex items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-800/80 mb-4">
              <div class="flex items-center gap-3">
                <div class="w-8 h-8 rounded-xl bg-blue-500/10 text-blue-500 flex items-center justify-center font-bold">
                  📥
                </div>
                <div>
                  <h3 class="text-base font-bold text-slate-900 dark:text-white tracking-tight">即时收件箱</h3>
                  <p class="text-xs text-slate-500 dark:text-slate-400">实时接收并解析往来邮件与验证码</p>
                </div>
              </div>
              <n-button @click="useSimpleIndex = true" tertiary size="small" class="rounded-xl">
                <template #icon>
                  <n-icon>
                    <FullscreenExitOutlined />
                  </n-icon>
                </template>
                {{ t('enterSimpleMode') }}
              </n-button>
            </div>

            <div v-if="showMailIdQuery" style="margin-bottom: 10px;">
              <n-input-group>
                <n-input v-model:value="mailIdQuery" class="rounded-xl" />
                <n-button @click="queryMail" type="primary" tertiary class="rounded-xl">
                  {{ t('query') }}
                </n-button>
              </n-input-group>
            </div>

            <MailBox :key="mailBoxKey" :showEMailTo="false" :showReply="openSettings.enableSendMail" :showSaveS3="openSettings.isS3Enabled"
              :saveToS3="saveToS3" :enableUserDeleteEmail="openSettings.enableUserDeleteEmail"
              :fetchMailData="fetchMailData" :deleteMail="deleteMail" :showFilterInput="true" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
