<script setup>
import { onMounted, ref } from 'vue'
import { useScopedI18n } from '@/i18n/app'
import { useRouter } from 'vue-router'
import { User, ExchangeAlt } from '@vicons/fa'
import { MailOutlined, ShieldOutlined } from '@vicons/material'

import { useGlobalState } from '../../store'
import { api } from '../../api'
import Login from '../common/Login.vue'
import TelegramAddress from './TelegramAddress.vue'
import LocalAddress from './LocalAddress.vue'
import AddressManagement from '../user/AddressManagement.vue'
import { getRouterPathWithLang } from '../../utils'
import AddressSelect from '../../components/AddressSelect.vue'
import AddressCredentialModal from '../../components/AddressCredentialModal.vue'
import StatusIndicator from '../../components/ai/StatusIndicator.vue'

const router = useRouter()

const {
    jwt, settings, showAddressCredential, userJwt,
    isTelegram, addressPassword
} = useGlobalState()

const { locale, t } = useScopedI18n('views.index.AddressBar')

const showAddressManage = ref(false)

const onUserLogin = async () => {
    await router.push(getRouterPathWithLang("/user", locale.value))
}

onMounted(async () => {
    await api.getSettings();
});
</script>

<template>
    <div class="mb-5">
        <n-card :bordered="false" embedded v-if="!settings.fetched" class="rounded-2xl shadow-sm border border-slate-200/60 dark:border-slate-800/80">
            <n-skeleton style="height: 40vh" class="rounded-xl" />
        </n-card>

        <div v-else-if="settings.address" class="p-3 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md rounded-2xl border border-slate-200/80 dark:border-slate-800/80 shadow-sm transition-all">
            <AddressSelect>
                <template #actions>
                    <n-button class="address-manage rounded-xl font-medium" size="small" tertiary type="primary"
                        @click="showAddressManage = true">
                        <n-icon :component="ExchangeAlt" class="mr-1" />
                        {{ t('addressManage') }}
                    </n-button>
                </template>
            </AddressSelect>
        </div>

        <div v-else-if="isTelegram">
            <TelegramAddress />
        </div>

        <div v-else-if="userJwt" class="w-full">
            <AddressManagement />
        </div>

        <div v-else class="hero-auth-container flex flex-col items-center justify-center my-6">
            <!-- Modern Hero Badge -->
            <div class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 text-xs font-semibold tracking-wide border border-blue-200/60 dark:border-blue-800/60 mb-4 shadow-xs">
                <StatusIndicator status="online" size="sm" />
                <span>Next-Gen Temporary & Unified Mailbox</span>
            </div>

            <h1 class="text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-white tracking-tight text-center mb-2">
                智能隐私收件箱
            </h1>
            <p class="text-sm sm:text-base text-slate-500 dark:text-slate-400 text-center max-w-md mb-6">
                即时生成临时邮箱、智能提取验证码，多账号多源合一
            </p>

            <div class="w-full max-w-[540px] p-6 sm:p-8 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl rounded-3xl border border-slate-200/80 dark:border-slate-800/80 shadow-xl shadow-slate-200/40 dark:shadow-black/40">
                <n-alert v-if="jwt" type="warning" :show-icon="false" :bordered="false" closable class="mb-4 rounded-xl">
                    <span>{{ t('fetchAddressError') }}</span>
                </n-alert>

                <Login />

                <div class="relative flex py-4 items-center">
                    <div class="flex-grow border-t border-slate-200 dark:border-slate-800"></div>
                    <span class="flex-shrink mx-4 text-xs font-medium text-slate-400 uppercase tracking-wider">或已有账号</span>
                    <div class="flex-grow border-t border-slate-200 dark:border-slate-800"></div>
                </div>

                <n-button @click="onUserLogin" type="primary" block secondary size="large" class="rounded-xl font-medium">
                    <template #icon>
                        <n-icon :component="User" />
                    </template>
                    {{ t('userLogin') }}
                </n-button>
            </div>
        </div>

        <AddressCredentialModal v-model:show="showAddressCredential" :address="settings.address" :jwt="jwt"
            :address-password="addressPassword" />
        <n-modal v-model:show="showAddressManage" preset="card" :title="t('addressManage')"
            style="width: 720px;" class="rounded-3xl">
            <TelegramAddress v-if="isTelegram" />
            <AddressManagement v-else-if="userJwt" />
            <LocalAddress v-else />
        </n-modal>
    </div>
</template>

<style scoped>
.center {
    display: flex;
    justify-content: center;
}

.address-manage {
    flex: 0 0 auto;
    white-space: nowrap;
}
</style>
