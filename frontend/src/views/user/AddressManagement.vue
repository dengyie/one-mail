<script setup>
import { ref, h, onMounted, watch } from 'vue'
import { useMessage } from 'naive-ui'
import { useScopedI18n } from '@/i18n/app'
import { useRouter } from 'vue-router'
import { NBadge, NPopconfirm, NButton, NTag } from 'naive-ui'

import { useGlobalState } from '../../store'
import { api } from '../../api'
import { getRouterPathWithLang } from '../../utils'

import Login from '../common/Login.vue'

const { jwt, settings } = useGlobalState()
const message = useMessage()
const router = useRouter()

const { locale, t } = useScopedI18n('views.user.AddressManagement')

const data = ref([])
const count = ref(0)
const page = ref(1)
const pageSize = ref(20)
const showTranferAddress = ref(false)
const showCreateModal = ref(false)
const currentAddress = ref("")
const currentAddressId = ref(0)
const targetUserEmail = ref('')

const changeMailAddress = async (address_id) => {
    try {
        const res = await api.fetch(`/user_api/bind_address_jwt/${address_id}`)
        message.success(t('changeMailAddress') + " " + t('success'))
        if (!res.jwt) {
            message.error("jwt not found")
            return
        }
        jwt.value = res.jwt
        await api.getSettings()
        await router.push(getRouterPathWithLang("/mailbox", locale.value))
    } catch (error) {
        console.log(error)
        message.error(error.message || "error")
    }
}

const unbindAddress = async (address_id) => {
    try {
        await api.fetch(`/user_api/unbind_address`, {
            method: 'POST',
            body: JSON.stringify({ address_id })
        })
        message.success(t('unbindAddress') + " " + t('success'))
        if (page.value === 1) {
            await fetchData()
        } else {
            page.value = 1
        }
    } catch (error) {
        console.log(error)
        message.error(error.message || "error")
    }
}

const transferAddress = async () => {
    if (!targetUserEmail.value) {
        message.error("targetUserEmail is required")
        return
    }
    if (!currentAddressId.value) {
        message.error("currentAddressId is required")
        return
    }
    try {
        await api.fetch(`/user_api/transfer_address`, {
            method: 'POST',
            body: JSON.stringify({
                address_id: currentAddressId.value,
                target_user_email: targetUserEmail.value
            })
        })
        message.success(t('transferAddress') + " " + t('success'))
        if (page.value === 1) {
            await fetchData()
        } else {
            page.value = 1
        }
        showTranferAddress.value = false
        currentAddressId.value = 0
        currentAddress.value = ""
        targetUserEmail.value = ""
    } catch (error) {
        console.log(error)
        message.error(error.message || "error")
    }
}

const fetchData = async () => {
    try {
        const params = new URLSearchParams({
            limit: String(pageSize.value),
            offset: String((page.value - 1) * pageSize.value)
        })
        const res = await api.fetch(`/user_api/bind_address?${params.toString()}`)
        if (res && res.results) {
            data.value = res.results
            count.value = res.count || res.results.length
        }
    } catch (error) {
        console.log(error)
        message.error(error.message || "error")
    }
}

const columns = [
    {
        title: t('name') || '邮箱地址',
        key: 'name',
        render(row) {
            const isCurrent = settings.value?.address === row.name
            return h('div', { class: 'flex items-center gap-2 py-1 font-mono text-sm' }, [
                h('span', { class: 'font-semibold text-slate-800 dark:text-slate-200' }, row.name),
                isCurrent ? h(NTag, { size: 'small', type: 'success', round: true }, { default: () => '当前使用中' }) : null
            ])
        }
    },
    {
        title: t('mail_count') || '邮件数',
        key: 'mail_count',
        render(row) {
            return h(NBadge, {
                value: row.mail_count || 0,
                max: 999,
                type: "info"
            })
        }
    },
    {
        title: t('actions') || '操作',
        key: 'actions',
        render(row) {
            return h('div', { class: 'flex items-center gap-2' }, [
                h(NPopconfirm,
                    {
                        onPositiveClick: () => changeMailAddress(row.id)
                    },
                    {
                        trigger: () => h(NButton,
                            {
                                size: 'small',
                                tertiary: true,
                                type: "primary",
                                class: 'rounded-lg'
                            },
                            { default: () => t('changeMailAddress') || '切换至该地址' }
                        ),
                        default: () => `${t('changeMailAddress')}?`
                    }
                ),
                h(NButton,
                    {
                        size: 'small',
                        tertiary: true,
                        type: "default",
                        class: 'rounded-lg',
                        onClick: () => {
                            currentAddressId.value = row.id
                            currentAddress.value = row.name
                            showTranferAddress.value = true
                        }
                    },
                    { default: () => t('transferAddress') || '转让' }
                ),
                h(NPopconfirm,
                    {
                        onPositiveClick: () => unbindAddress(row.id)
                    },
                    {
                        trigger: () => h(NButton,
                            {
                                size: 'small',
                                tertiary: true,
                                type: "error",
                                class: 'rounded-lg'
                            },
                            { default: () => t('unbindAddress') || '解绑' }
                        ),
                        default: () => t('unbindAddressTip') || '确认解绑此邮箱？'
                    }
                ),
            ])
        }
    }
]

onMounted(async () => {
    await fetchData()
})

watch([page, pageSize], async () => {
    await fetchData()
})
</script>

<template>
    <div class="space-y-6">
        <!-- 弹窗：转让地址 -->
        <n-modal v-model:show="showTranferAddress" preset="dialog" :title="t('transferAddress')" class="rounded-3xl">
            <div class="space-y-3 py-2">
                <p class="text-xs text-slate-500">{{ t("transferAddressTip") }}</p>
                <div class="p-3 bg-slate-100 dark:bg-slate-800 rounded-xl font-mono text-xs font-semibold">
                    {{ currentAddress }}
                </div>
                <n-input v-model:value="targetUserEmail" :placeholder="t('targetUserEmail')" class="rounded-xl" />
            </div>
            <template #action>
                <n-button @click="transferAddress" size="small" type="error" secondary class="rounded-xl">
                    {{ t('transferAddress') }}
                </n-button>
            </template>
        </n-modal>

        <!-- 弹窗：新建或绑定地址 -->
        <n-modal v-model:show="showCreateModal" preset="card" title="新建或绑定专属邮箱地址" class="rounded-3xl max-w-lg">
            <div class="py-2">
                <Login />
            </div>
        </n-modal>

        <!-- 地址列表主面板（纯内容视图，零顶部内嵌 Tab） -->
        <div class="bg-white/90 dark:bg-slate-900/90 backdrop-blur-xl rounded-3xl border border-slate-200/80 dark:border-slate-800/80 p-5 sm:p-7 shadow-sm space-y-6">
            <div class="flex items-center justify-between flex-wrap gap-4 pb-4 border-b border-slate-100 dark:border-slate-800/80">
                <div>
                    <h2 class="text-xl font-bold text-slate-900 dark:text-white tracking-tight">专属邮箱地址管理</h2>
                    <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">永久绑定到当前账号的名下邮箱，随时切换收信身份与转让管理</p>
                </div>
                <n-button @click="showCreateModal = true" type="primary" class="rounded-xl font-medium shadow-xs">
                    + 创建 / 绑定新邮箱
                </n-button>
            </div>

            <div class="space-y-4">
                <div class="flex items-center justify-between text-xs text-slate-500">
                    <span>共绑定 {{ count }} 个专属邮箱地址</span>
                    <n-pagination v-model:page="page" v-model:page-size="pageSize" :item-count="count" :page-sizes="[20, 50, 100]" size="small" />
                </div>
                <n-data-table :columns="columns" :data="data" :bordered="false" class="rounded-2xl overflow-hidden" />
            </div>
        </div>
    </div>
</template>
