<script setup>
import { useScopedI18n } from '@/i18n/app'

import { useGlobalState } from '../store'

import AddressMangement from './user/AddressManagement.vue';
import UserSettingsPage from './user/UserSettings.vue';
import UserBar from './user/UserBar.vue';
import BindAddress from './user/BindAddress.vue';
import UserMailBox from './user/UserMailBox.vue';
import UserMailAccounts from './user/UserMailAccounts.vue';

const {
    userTab, globalTabplacement, userSettings
} = useGlobalState()

const { t } = useScopedI18n('views.User')

</script>

<template>
    <div class="space-y-6">
        <UserBar />
        <div v-if="userSettings.user_email" class="space-y-6">
            <!-- 直接展示地址管理 -->
            <div class="bg-white/90 dark:bg-slate-900/90 backdrop-blur-xl rounded-3xl border border-slate-200/80 dark:border-slate-800/80 p-4 sm:p-6 shadow-sm">
                <AddressMangement />
            </div>
        </div>
    </div>
</template>
