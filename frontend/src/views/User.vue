<script setup>
import { useScopedI18n } from '@/i18n/app'
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useGlobalState } from '../store'

import AddressMangement from './user/AddressManagement.vue'
import UserSettingsPage from './user/UserSettings.vue'
import UserMailAccounts from './user/UserMailAccounts.vue'
import Appearance from './common/Appearance.vue'

const { userSettings } = useGlobalState()
const route = useRoute()
const { t } = useScopedI18n('views.User')

const currentUserView = computed(() => {
    const p = route.path
    if (p.includes('/user/external-accounts')) return 'external'
    if (p.includes('/user/settings')) return 'settings'
    if (p.includes('/user/appearance')) return 'appearance'
    return 'addresses'
})
</script>

<template>
    <div class="space-y-6">
        <div v-if="userSettings.user_email" class="space-y-6">
            
            <!-- 专属地址管理视图 -->
            <div v-if="currentUserView === 'addresses'">
                <AddressMangement />
            </div>

            <!-- 外部邮箱归集 (IMAP) 视图 -->
            <div v-else-if="currentUserView === 'external'">
                <UserMailAccounts />
            </div>

            <!-- 个人安全与偏好设置视图 -->
            <div v-else-if="currentUserView === 'settings'">
                <UserSettingsPage />
            </div>

            <!-- 外观与个性化视图 -->
            <div v-else-if="currentUserView === 'appearance'">
                <Appearance />
            </div>

        </div>
    </div>
</template>
