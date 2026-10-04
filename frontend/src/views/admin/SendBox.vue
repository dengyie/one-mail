<script setup>
import { computed, ref } from 'vue'
import { useScopedI18n } from '@/i18n/app'
import { useGlobalState } from '../../store'
import { api } from '../../api'
import SendHistoryPane from '../../components/SendHistoryPane.vue'

const { adminSendBoxTabAddress } = useGlobalState()
const { t } = useScopedI18n('views.admin.SendBox')
const historyT = useScopedI18n('components.SendHistory').t

const sourceFilter = ref('')
const refreshKey = ref(0)
const autoRefresh = ref(false)

const sourceOptions = computed(() => [
  { label: t('allSources'), value: '' },
  { label: historyT('sourceUserUi'), value: 'user_ui' },
  { label: historyT('sourceUserApi'), value: 'user_api' },
  { label: historyT('sourceExternalApi'), value: 'external_api' },
  { label: historyT('sourceSmtpProxy'), value: 'smtp_proxy' },
  { label: historyT('sourceAdmin'), value: 'admin' },
  { label: historyT('sourceAdminBinding'), value: 'admin_binding' },
  { label: historyT('sourceSystemOtp'), value: 'system_otp' },
  { label: historyT('sourceUnknown'), value: 'unknown' },
])

const applyQuery = () => {
  adminSendBoxTabAddress.value = `${adminSendBoxTabAddress.value || ''}`.trim()
  refreshKey.value += 1
}

const deleteSenboxMail = async (curMailId) => {
  await api.fetch(`/admin/sendbox/${curMailId}`, { method: 'DELETE' })
}
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-center gap-2">
      <n-input
        v-model:value="adminSendBoxTabAddress"
        :placeholder="t('queryTip')"
        @keydown.enter="applyQuery"
      />
      <n-select
        v-model:value="sourceFilter"
        :options="sourceOptions"
        style="width: 180px"
        @update:value="applyQuery"
      />
      <n-button type="primary" tertiary @click="applyQuery">
        {{ t('query') }}
      </n-button>
      <n-switch v-model:value="autoRefresh" size="small" :round="false">
        <template #checked>{{ t('autoRefreshOn') }}</template>
        <template #unchecked>{{ t('autoRefreshOff') }}</template>
      </n-switch>
    </div>
    <SendHistoryPane
      endpoint="/admin/sendbox"
      :source="sourceFilter"
      :address="adminSendBoxTabAddress"
      :enable-user-delete-email="true"
      :delete-mail="deleteSenboxMail"
      :show-from="true"
      :collapse-otp="true"
      :refresh-key="refreshKey"
      :auto-refresh="autoRefresh"
    />
  </div>
</template>
