<script setup>
import { useMessage } from 'naive-ui'
import { ref, h, onMounted, watch } from 'vue';
import { useScopedI18n } from '@/i18n/app'
import { User, UserCheck, MailBulk } from '@vicons/fa'
import { SendOutlined } from '@vicons/material'

import { api } from '../../api'

const message = useMessage()

const { t } = useScopedI18n('views.admin.Statistics')

const statistics = ref({
    addressCount: 0,
    userCount: 0,
    mailCount: 0,
    activeAddressCount7days: 0,
    activeAddressCount30days: 0,
    sendMailCount: 0,
})

const fetchStatistics = async () => {
    try {
        const {
            userCount, mailCount, sendMailCount,
            addressCount, activeAddressCount7days,
            activeAddressCount30days,
        } = await api.fetch(`/admin/statistics`);
        statistics.value.mailCount = mailCount || 0;
        statistics.value.sendMailCount = sendMailCount || 0;
        statistics.value.userCount = userCount || 0;
        statistics.value.addressCount = addressCount || 0;
        statistics.value.activeAddressCount7days = activeAddressCount7days || 0;
        statistics.value.activeAddressCount30days = activeAddressCount30days || 0;
    } catch (error) {
        console.log(error)
        message.error(error.message || "error");
    }
}

onMounted(async () => {
    await fetchStatistics()
})
</script>

<template>
    <div class="space-y-6">
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div class="p-5 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/60 flex items-center gap-4">
                <div class="w-12 h-12 rounded-2xl bg-blue-500/10 text-blue-500 flex items-center justify-center text-xl font-bold">
                    <n-icon :component="User" />
                </div>
                <div>
                    <p class="text-xs font-semibold text-slate-500 dark:text-slate-400">{{ t('addressCount') }}</p>
                    <p class="text-2xl font-extrabold text-slate-900 dark:text-white mt-0.5 font-mono">{{ statistics.addressCount }}</p>
                </div>
            </div>

            <div class="p-5 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/60 flex items-center gap-4">
                <div class="w-12 h-12 rounded-2xl bg-indigo-500/10 text-indigo-500 flex items-center justify-center text-xl font-bold">
                    <n-icon :component="UserCheck" />
                </div>
                <div>
                    <p class="text-xs font-semibold text-slate-500 dark:text-slate-400">{{ t('activeAddressCount7days') }}</p>
                    <p class="text-2xl font-extrabold text-slate-900 dark:text-white mt-0.5 font-mono">{{ statistics.activeAddressCount7days }}</p>
                </div>
            </div>

            <div class="p-5 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/60 flex items-center gap-4">
                <div class="w-12 h-12 rounded-2xl bg-purple-500/10 text-purple-500 flex items-center justify-center text-xl font-bold">
                    <n-icon :component="UserCheck" />
                </div>
                <div>
                    <p class="text-xs font-semibold text-slate-500 dark:text-slate-400">{{ t('activeAddressCount30days') }}</p>
                    <p class="text-2xl font-extrabold text-slate-900 dark:text-white mt-0.5 font-mono">{{ statistics.activeAddressCount30days }}</p>
                </div>
            </div>

            <div class="p-5 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/60 flex items-center gap-4">
                <div class="w-12 h-12 rounded-2xl bg-emerald-500/10 text-emerald-500 flex items-center justify-center text-xl font-bold">
                    <n-icon :component="User" />
                </div>
                <div>
                    <p class="text-xs font-semibold text-slate-500 dark:text-slate-400">{{ t('userCount') }}</p>
                    <p class="text-2xl font-extrabold text-slate-900 dark:text-white mt-0.5 font-mono">{{ statistics.userCount }}</p>
                </div>
            </div>

            <div class="p-5 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/60 flex items-center gap-4">
                <div class="w-12 h-12 rounded-2xl bg-cyan-500/10 text-cyan-500 flex items-center justify-center text-xl font-bold">
                    <n-icon :component="MailBulk" />
                </div>
                <div>
                    <p class="text-xs font-semibold text-slate-500 dark:text-slate-400">{{ t('mailCount') }}</p>
                    <p class="text-2xl font-extrabold text-slate-900 dark:text-white mt-0.5 font-mono">{{ statistics.mailCount }}</p>
                </div>
            </div>

            <div class="p-5 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/60 flex items-center gap-4">
                <div class="w-12 h-12 rounded-2xl bg-amber-500/10 text-amber-500 flex items-center justify-center text-xl font-bold">
                    <n-icon :component="SendOutlined" />
                </div>
                <div>
                    <p class="text-xs font-semibold text-slate-500 dark:text-slate-400">{{ t('sendMailCount') }}</p>
                    <p class="text-2xl font-extrabold text-slate-900 dark:text-white mt-0.5 font-mono">{{ statistics.sendMailCount }}</p>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.n-card {
    margin-bottom: 20px;
}
</style>
