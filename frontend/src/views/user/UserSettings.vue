<script setup>
import { ref, h } from 'vue'
import { useMessage } from 'naive-ui'
import { useScopedI18n } from '@/i18n/app'
import { startRegistration } from '@simplewebauthn/browser'
import { NButton, NPopconfirm } from 'naive-ui'

import { useGlobalState } from '../../store'
import { api } from '../../api'
import { clearLocalAddressCache } from '../../utils/address-cache'

const {
    userJwt, userSettings, auth, jwt,
    addressPassword, userOauth2SessionState, userOauth2SessionClientID,
    unifiedApiKey,
} = useGlobalState()
const message = useMessage()

const showCreatePasskey = ref(false)
const passkeyName = ref('')
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
        message.error('新密码不能为空')
        return
    }
    if (newPassword.value !== confirmPassword.value) {
        message.error('两次输入的新密码不一致')
        return
    }
    changingPassword.value = true
    try {
        await api.userChangePassword({
            oldPassword: oldPassword.value,
            newPassword: newPassword.value
        })
        message.success('密码修改成功')
        oldPassword.value = ''
        newPassword.value = ''
        confirmPassword.value = ''
    } catch (e) {
        message.error(e.message || '修改密码失败')
    } finally {
        changingPassword.value = false
    }
}

const createPasskey = async () => {
    try {
        const options = await api.fetch(`/user_api/passkey/register_request`, {
            method: 'POST',
            body: JSON.stringify({
                domain: location.hostname,
                name: passkeyName.value
            })
        })
        const res = await startRegistration({ optionsJSON: options })
        await api.fetch(`/user_api/passkey/register_response`, {
            method: 'POST',
            body: JSON.stringify({
                credential: res,
                origin: location.origin,
                passkey_name: passkeyName.value,
            })
        })
        message.success(t('createPasskey') + " " + t('success'))
        showCreatePasskey.value = false
        passkeyName.value = ''
    } catch (error) {
        console.log(error)
        message.error(error.message || "error")
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

const passkeyColumns = [
    { title: t('passkey_name') || '名称', key: 'name' },
    {
        title: t('passkeyCreated') || '创建时间',
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
]

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
</script>

<template>
    <div class="space-y-6">
        <!-- 弹窗：新建 Passkey -->
        <n-modal v-model:show="showCreatePasskey" preset="dialog" :title="t('createPasskey')" class="rounded-3xl">
            <div class="py-2">
                <n-input v-model:value="passkeyName" :placeholder="t('passkey_name')" class="rounded-xl" />
            </div>
            <template #action>
                <n-button @click="createPasskey" type="primary" class="rounded-xl">
                    {{ t('createPasskey') }}
                </n-button>
            </template>
        </n-modal>

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
            <div class="bg-white/90 dark:bg-slate-900/90 backdrop-blur-xl rounded-3xl border border-slate-200/80 dark:border-slate-800/80 p-5 sm:p-7 shadow-sm space-y-5">
                <div class="pb-3 border-b border-slate-100 dark:border-slate-800/80">
                    <h3 class="text-base font-bold text-slate-900 dark:text-white tracking-tight flex items-center gap-2">
                        <span>🔐</span>
                        <span>账户身份与通行密钥 (Passkey)</span>
                    </h3>
                    <p class="text-xs text-slate-500 mt-1">使用指纹、FaceID 或安全密钥实现现代免密极速登录</p>
                </div>

                <div class="space-y-3">
                    <div class="p-3 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/60 flex items-center justify-between">
                        <div>
                            <span class="text-xs text-slate-500 block">注册邮箱账号</span>
                            <span class="text-sm font-bold text-slate-900 dark:text-white font-mono">{{ userSettings.user_email }}</span>
                        </div>
                        <span class="px-2.5 py-1 text-xs font-semibold rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                            {{ userSettings.is_admin ? '系统管理员' : '标准用户' }}
                        </span>
                    </div>

                    <div class="flex items-center gap-3 pt-2">
                        <n-button @click="showCreatePasskey = true" type="primary" secondary class="rounded-xl flex-1 font-medium">
                            {{ t('createPasskey') || '+ 绑定新 Passkey' }}
                        </n-button>
                        <n-button @click="() => { fetchPasskeyList(); showPasskeyList = true; }" tertiary class="rounded-xl flex-1">
                            {{ t('showPasskeyList') || '管理已有密钥' }}
                        </n-button>
                    </div>
                </div>
            </div>

            <!-- 卡片 2：修改登录密码 -->
            <div class="bg-white/90 dark:bg-slate-900/90 backdrop-blur-xl rounded-3xl border border-slate-200/80 dark:border-slate-800/80 p-5 sm:p-7 shadow-sm space-y-5">
                <div class="pb-3 border-b border-slate-100 dark:border-slate-800/80">
                    <h3 class="text-base font-bold text-slate-900 dark:text-white tracking-tight flex items-center gap-2">
                        <span>🛡️</span>
                        <span>修改密码</span>
                    </h3>
                    <p class="text-xs text-slate-500 mt-1">更新当前账号的登录密码，保障隐私与通信安全</p>
                </div>

                <div class="space-y-3">
                    <n-input v-model:value="oldPassword" type="password" show-password-on="click" placeholder="当前原密码" class="rounded-xl" />
                    <n-input v-model:value="newPassword" type="password" show-password-on="click" placeholder="新密码" class="rounded-xl" />
                    <n-input v-model:value="confirmPassword" type="password" show-password-on="click" placeholder="确认新密码" class="rounded-xl" />
                    <n-button @click="handleChangePassword" type="primary" block :loading="changingPassword" class="rounded-xl font-medium mt-2">
                        确认修改密码
                    </n-button>
                </div>
            </div>

        </div>
    </div>
</template>
