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
        <div v-if="userSettings.user_email" class="bg-white/90 dark:bg-slate-900/90 backdrop-blur-xl rounded-3xl border border-slate-200/80 dark:border-slate-800/80 p-4 sm:p-6 shadow-sm">
            <n-tabs type="segment" animated v-model:value="userTab" class="mb-4">
                <n-tab-pane name="address_management" :tab="t('address_management')">
                    <AddressMangement />
                </n-tab-pane>
                <n-tab-pane name="user_mail_box_tab" :tab="t('user_mail_box_tab')">
                    <UserMailBox />
                </n-tab-pane>
                <n-tab-pane name="user_mail_accounts" :tab="t('user_mail_accounts')">
                    <UserMailAccounts />
                </n-tab-pane>
                <n-tab-pane name="user_settings" :tab="t('user_settings')">
                    <UserSettingsPage />
                </n-tab-pane>
                <n-tab-pane name="bind_address" :tab="t('bind_address')">
                    <BindAddress />
                </n-tab-pane>
            </n-tabs>
        </div>
    </div>
</template>
