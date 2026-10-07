<script setup>
import MailIcon from '../../components/ui/MailIcon.vue'
import { ref, computed, h } from 'vue'
import { useMessage } from 'naive-ui'
import { useScopedI18n } from '@/i18n/app'
import { startRegistration } from '@simplewebauthn/browser'
import { NButton, NPopconfirm } from 'naive-ui'

import { useGlobalState } from '../../store'
import { api } from '../../api'

const { userSettings } = useGlobalState()
const message = useMessage()

const creatingPasskey = ref(false)
// 自动分配名字（分钟级时间戳），不再让用户手动命名；
// 后端在 passkey_name 为空时也会兜底，但前端带上便于列表里区分。
const autoPasskeyName = () => {
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    return `Passkey ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}
const showPasskeyList = ref(false)
const showRenamePasskey = ref(false)
const currentPasskeyId = ref(null)
const currentPasskeyName = ref('')

const oldPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const changingPassword = ref(false)

const { t } = useScopedI18n('views.user.UserSettings')

const handleChangePassword = async () => {
    if (!newPassword.value) {
        message.error(t('passwordRequired'))
        return
    }
    if (newPassword.value !== confirmPassword.value) {
        message.error(t('passwordMismatch'))
        return
    }
    changingPassword.value = true
    try {
        await api.userChangePassword({
            oldPassword: oldPassword.value,
            newPassword: newPassword.value
        })
        message.success(t('passwordChanged'))
        oldPassword.value = ''
        newPassword.value = ''
        confirmPassword.value = ''
    } catch (e) {
        message.error(e.message || t('passwordFailed'))
    } finally {
        changingPassword.value = false
    }
}

const createPasskey = async () => {
    if (creatingPasskey.value) return
    const passkeyName = autoPasskeyName()
    creatingPasskey.value = true
    try {
        const options = await api.fetch(`/user_api/passkey/register_request`, {
            method: 'POST',
            body: JSON.stringify({
                domain: location.hostname,
                name: passkeyName
            })
        })
        const res = await startRegistration({ optionsJSON: options })
        await api.fetch(`/user_api/passkey/register_response`, {
            method: 'POST',
            body: JSON.stringify({
                credential: res,
                origin: location.origin,
                passkey_name: passkeyName,
            })
        })
        message.success(t('createPasskey') + " " + t('success'))
    } catch (error) {
        console.log(error)
        message.error(error.message || "error")
    } finally {
        creatingPasskey.value = false
    }
}

const passkeyList = ref([])
const fetchPasskeyList = async () => {
    try {
        const res = await api.fetch(`/user_api/passkey`)
        passkeyList.value = (Array.isArray(res) ? res : []).map((row) => ({
            ...row,
            id: row.id ?? row.passkey_id,
            name: row.name ?? row.passkey_name,
        }))
    } catch (error) {
        console.log(error)
        message.error(error.message || "error")
    }
}

const passkeyColumns = computed(() => [
    { title: t('passkey_name') || '名称', key: 'name' },
    {
        title: t('created_at'),
        key: 'created_at',
        render(row) {
            return new Date(row.created_at).toLocaleString()
        }
    },
    {
        title: t('actions') || '操作',
        key: 'actions',
        render(row) {
            return h('div', { class: 'flex items-center gap-2' }, [
                h(NButton,
                    {
                        size: 'small',
                        tertiary: true,
                        onClick: () => {
                            currentPasskeyId.value = row.id
                            currentPasskeyName.value = row.name
                            showRenamePasskey.value = true
                        }
                    },
                    { default: () => t('renamePasskey') || '重命名' }
                ),
                h(NPopconfirm,
                    {
                        onPositiveClick: () => deletePasskey(row.id)
                    },
                    {
                        trigger: () => h(NButton,
                            {
                                size: 'small',
                                tertiary: true,
                                type: "error"
                            },
                            { default: () => t('deletePasskey') || '删除' }
                        ),
                        default: () => t('deletePasskeyTip') || '确认删除？'
                    }
                )
            ])
        }
    }
])

const renamePasskey = async () => {
    try {
        await api.fetch(`/user_api/passkey/rename`, {
            method: 'POST',
            body: JSON.stringify({
                passkey_id: currentPasskeyId.value,
                passkey_name: currentPasskeyName.value
            })
        })
        message.success(t('renamePasskey') + " " + t('success'))
        showRenamePasskey.value = false
        await fetchPasskeyList()
    } catch (error) {
        console.log(error)
        message.error(error.message || "error")
    }
}

const deletePasskey = async (id) => {
    try {
        await api.fetch(`/user_api/passkey/${encodeURIComponent(id)}`, {
            method: 'DELETE'
        })
        message.success(t('deletePasskey') + " " + t('success'))
        await fetchPasskeyList()
    } catch (error) {
        console.log(error)
        message.error(error.message || "error")
    }
}
const { t: w } = useScopedI18n('workspace')
</script>

<template>
    <div class="workspace-page settings-page">
        <div class="workspace-page-header"><div><div class="workspace-eyebrow">{{ w('account') }}</div><h1>{{ w('security') }}</h1><p>{{ w('securityDescription') }}</p></div></div>
        <!-- 弹窗：重命名 Passkey -->
        <n-modal v-model:show="showRenamePasskey" preset="dialog" :title="t('renamePasskey')" class="rounded-3xl">
            <div class="py-2">
                <n-input v-model:value="currentPasskeyName" :placeholder="t('passkey_name')" class="rounded-xl" />
            </div>
            <template #action>
                <n-button @click="renamePasskey" type="primary" class="rounded-xl">
                    {{ t('renamePasskey') }}
                </n-button>
            </template>
        </n-modal>

        <!-- 弹窗：Passkey 列表 -->
        <n-modal v-model:show="showPasskeyList" preset="card" :title="t('showPasskeyList')" class="rounded-3xl max-w-xl">
            <n-data-table :columns="passkeyColumns" :data="passkeyList" :bordered="false" class="rounded-2xl overflow-hidden" />
        </n-modal>

        <!-- 主设置区域（纯内容视图） -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
            
            <!-- 卡片 1：账号信息与通行密钥 (Passkey) -->
            <div class="settings-section space-y-5">
                <div class="pb-3 border-b border-slate-100 dark:border-slate-800/80">
                    <h3 class="text-base font-bold text-slate-900 dark:text-white tracking-tight flex items-center gap-2">
                        <MailIcon name="key" :size="19" />
                        <span>{{ t('passkeyTitle') }}</span>
                    </h3>
                    <p class="text-xs text-slate-500 mt-1">{{ t('passkeyDescription') }}</p>
                </div>

                <div class="space-y-3">
                    <div class="p-3 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/60 flex items-center justify-between gap-3 flex-wrap">
                        <div>
                            <span class="text-xs text-slate-500 block">{{ w('emailLabel') }}</span>
                            <span class="text-sm font-bold text-slate-900 dark:text-white font-mono">{{ userSettings.user_email }}</span>
                        </div>
                        <span class="px-2.5 py-1 text-xs font-semibold rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                            {{ userSettings.is_admin ? w('administrator') : w('member') }}
                        </span>
                    </div>

                    <div class="flex items-center gap-3 pt-2 flex-wrap">
                        <n-button @click="createPasskey" :loading="creatingPasskey" type="primary" secondary class="rounded-xl flex-1 font-medium">
                            {{ t('createPasskey') || '+ 绑定新 Passkey' }}
                        </n-button>
                        <n-button @click="() => { fetchPasskeyList(); showPasskeyList = true; }" tertiary class="rounded-xl flex-1">
                            {{ t('showPasskeyList') || '管理已有密钥' }}
                        </n-button>
                    </div>
                </div>
            </div>

            <!-- 卡片 2：修改登录密码 -->
            <div class="settings-section space-y-5">
                <div class="pb-3 border-b border-slate-100 dark:border-slate-800/80">
                    <h3 class="text-base font-bold text-slate-900 dark:text-white tracking-tight flex items-center gap-2">
                        <MailIcon name="shield" :size="19" />
                        <span>{{ t('changePassword') }}</span>
                    </h3>
                    <p class="text-xs text-slate-500 mt-1">{{ t('passwordDescription') }}</p>
                </div>

                <div class="space-y-3">
                    <n-input v-model:value="oldPassword" type="password" show-password-on="click" :placeholder="t('oldPassword')" :input-props="{ 'aria-label': t('oldPassword'), autocomplete: 'current-password' }" class="rounded-xl" />
                    <n-input v-model:value="newPassword" type="password" show-password-on="click" :placeholder="t('newPassword')" :input-props="{ 'aria-label': t('newPassword'), autocomplete: 'new-password' }" class="rounded-xl" />
                    <n-input v-model:value="confirmPassword" type="password" show-password-on="click" :placeholder="t('confirmPassword')" :input-props="{ 'aria-label': t('confirmPassword'), autocomplete: 'new-password' }" class="rounded-xl" />
                    <n-button @click="handleChangePassword" type="primary" block :loading="changingPassword" class="rounded-xl font-medium mt-2">
                        {{ t('changePassword') }}
                    </n-button>
                </div>
            </div>

        </div>
    </div>
</template>
