<script setup>
import { onMounted } from 'vue'
import { useScopedI18n } from '@/i18n/app'
import { useRouter } from 'vue-router'

import { useGlobalState } from '../../store'
import { api } from '../../api'
import UserLogin from './UserLogin.vue'

const message = useMessage()
const router = useRouter()

const {
    userSettings, userJwt, userOpenSettings
} = useGlobalState()

const { t } = useScopedI18n('views.user.UserBar')


onMounted(async () => {
    await api.getUserOpenSettings(message);
    // make sure user_id is fetched
    if (!userSettings.value.user_id) await api.getUserSettings(message);
});
</script>

<template>
    <div>
        <div v-if="!userSettings.fetched" class="p-8 bg-white/80 dark:bg-slate-900/80 rounded-3xl border border-slate-200/80 dark:border-slate-800/80 shadow-sm">
            <n-skeleton style="height: 35vh" class="rounded-2xl" />
        </div>
        
        <div v-else-if="userSettings.user_email" class="flex items-center justify-between p-4 px-6 bg-gradient-to-r from-blue-600/10 via-indigo-600/10 to-transparent dark:from-blue-900/20 dark:via-indigo-900/20 dark:to-transparent rounded-2xl border border-blue-200/60 dark:border-blue-800/60 shadow-xs">
            <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold text-sm shadow-sm">
                    {{ userSettings.user_email[0].toUpperCase() }}
                </div>
                <div class="flex flex-col">
                    <span class="text-xs text-slate-500 dark:text-slate-400 font-medium">{{ t('currentUser') }}</span>
                    <span class="text-sm font-bold text-slate-900 dark:text-white tracking-tight">{{ userSettings.user_email }}</span>
                </div>
            </div>
            <span class="px-2.5 py-1 text-xs font-semibold rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                已认证
            </span>
        </div>

        <div v-else class="flex flex-col items-center justify-center my-4">
            <div class="w-full max-w-[560px] p-6 sm:p-8 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl rounded-3xl border border-slate-200/80 dark:border-slate-800/80 shadow-xl shadow-slate-200/40 dark:shadow-black/40">
                <n-alert v-if="userJwt" type="warning" :show-icon="false" :bordered="false" closable class="mb-4 rounded-xl">
                    <span>{{ t('fetchUserSettingsError') }}</span>
                </n-alert>
                <UserLogin />
            </div>
        </div>
    </div>
</template>

<style scoped>
.n-alert {
    margin-top: 10px;
    margin-bottom: 10px;
    text-align: center;
}

.center {
    display: flex;
    text-align: center;
    place-items: center;
    justify-content: center;
    margin: 20px;
}
</style>
