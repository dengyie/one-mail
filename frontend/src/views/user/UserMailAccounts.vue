<script setup>
import { ref, computed, onMounted, h } from 'vue'
import { useScopedI18n } from '@/i18n/app'
import { NButton, NTag, NPopconfirm, useMessage } from 'naive-ui'

import { useGlobalState } from '../../store'
import { api } from '../../api'

const { userJwt, userSettings } = useGlobalState()
const message = useMessage()

const { t } = useScopedI18n('views.user.UserMailAccounts')

const list = ref([])
const loading = ref(false)
const showModal = ref(false)
const submitting = ref(false)

const sourceOptions = [
    { label: 'Gmail', value: 'imap_gmail', host: 'imap.gmail.com', port: 993 },
    { label: 'Outlook / Hotmail', value: 'imap_outlook', host: 'outlook.office365.com', port: 993 },
    { label: 'QQ 邮箱', value: 'imap_qq', host: 'imap.qq.com', port: 993 },
    { label: '163 网易邮箱', value: 'imap_163', host: 'imap.163.com', port: 993 },
    { label: '自定义 IMAP 服务器', value: 'imap_custom', host: '', port: 993 },
]
const protocolOptions = computed(() => ([
    { label: t('auto') || '自动', value: 'auto' },
    { label: t('imap') || 'IMAP', value: 'imap' },
    { label: t('pop3') || 'POP3', value: 'pop3' },
]))

const form = ref(emptyForm())

function emptyForm() {
    return { label: '', source: 'imap_gmail', host: 'imap.gmail.com', port: 993,
        username: '', cred: '', protocol: 'auto', folders: '' }
}

const onSourceChange = (v) => {
    const opt = sourceOptions.find(o => o.value === v)
    if (opt && opt.host) {
        form.value.host = opt.host
        form.value.port = opt.port
    }
}

const fetchData = async () => {
    loading.value = true
    try {
        const res = await api.userMailAccounts.list()
        list.value = res.results || []
    } catch (e) {
        message.error(e.message || 'error')
    } finally {
        loading.value = false
    }
}

const submit = async () => {
    const f = form.value
    if (!f.username || !f.host || !f.cred || !f.port) {
        message.error('请填写完整的邮箱服务器与授权信息')
        return
    }
    submitting.value = true
    try {
        const folders = f.folders ? f.folders.split(',').map(s => s.trim()).filter(Boolean) : []
        await api.userMailAccounts.create(JSON.stringify({
            label: f.label, source: f.source, host: f.host, port: Number(f.port),
            username: f.username, cred: f.cred, protocol: f.protocol, folders,
        }))
        message.success(t('addSuccessTip') || '添加外部邮箱成功')
        showModal.value = false
        form.value = emptyForm()
        await fetchData()
    } catch (e) {
        message.error(e.message || 'error')
    } finally {
        submitting.value = false
    }
}

const toggle = async (row) => {
    try {
        await api.userMailAccounts.toggle(row.id)
        await fetchData()
    } catch (e) {
        message.error(e.message || 'error')
    }
}

const remove = async (row) => {
    try {
        await api.userMailAccounts.remove(row.id)
        message.success(t('delete') + ' ' + t('success'))
        await fetchData()
    } catch (e) {
        message.error(e.message || 'error')
    }
}

const columns = [
    { title: t('label') || '标识名称', key: 'label', render(r) { return r.label || r.username } },
    { title: t('source') || '渠道类型', key: 'source', render(r) { return h(NTag, { type: 'info', size: 'small', round: true }, { default: () => r.source }) } },
    { title: t('username') || '账号', key: 'username' },
    { title: t('host') || '服务器', key: 'host', render(r) { return `${r.host}:${r.port}` } },
    {
        title: t('status') || '自动同步',
        key: 'enabled',
        render(row) {
            return h(NButton, {
                size: 'small',
                type: row.enabled ? 'success' : 'default',
                quaternary: true,
                onClick: () => toggle(row),
            }, { default: () => (row.enabled ? (t('enabled') || '同步中') : (t('disabled') || '已暂停')) })
        }
    },
    {
        title: t('lastSync') || '最近同步',
        key: 'last_sync_at',
        render(r) {
            return r.last_sync_at ? new Date(r.last_sync_at).toLocaleString() : (t('never') || '从未')
        }
    },
    {
        title: t('actions') || '操作',
        key: 'actions',
        render(row) {
            return h(NPopconfirm, {
                onPositiveClick: () => remove(row),
            }, {
                trigger: () => h(NButton, { size: 'small', type: 'error', tertiary: true, class: 'rounded-lg' }, { default: () => t('delete') || '删除' }),
                default: () => t('deleteConfirm') || '确认移除该外部邮箱？'
            })
        }
    }
]

onMounted(async () => {
    if (userJwt.value) await fetchData()
})
</script>

<template>
    <div class="space-y-6">
        <!-- 弹窗：添加外部邮箱 -->
        <n-modal v-model:show="showModal" preset="card" title="添加外部邮箱归集 (IMAP/POP3)" class="rounded-3xl max-w-lg">
            <n-form :model="form" label-placement="top" class="space-y-3">
                <n-form-item label="邮箱类型">
                    <n-select v-model:value="form.source" :options="sourceOptions" @update:value="onSourceChange" class="rounded-xl" />
                </n-form-item>
                <n-form-item label="自定义标签 (选填)">
                    <n-input v-model:value="form.label" placeholder="如：我的个人 QQ 邮箱" class="rounded-xl" />
                </n-form-item>
                <n-form-item label="邮箱地址 / 用户名">
                    <n-input v-model:value="form.username" placeholder="user@example.com" class="rounded-xl" />
                </n-form-item>
                <n-form-item label="授权码 / 应用专用密码">
                    <n-input v-model:value="form.cred" type="password" show-password-on="click" placeholder="SMTP/IMAP 专属授权凭据" class="rounded-xl" />
                </n-form-item>
                <div class="grid grid-cols-2 gap-3">
                    <n-form-item label="IMAP 主机">
                        <n-input v-model:value="form.host" placeholder="imap.example.com" class="rounded-xl" />
                    </n-form-item>
                    <n-form-item label="端口">
                        <n-input-number v-model:value="form.port" class="rounded-xl w-full" />
                    </n-form-item>
                </div>
                <div class="flex justify-end gap-3 pt-4">
                    <n-button @click="showModal = false" class="rounded-xl">取消</n-button>
                    <n-button type="primary" :loading="submitting" @click="submit" class="rounded-xl px-5 font-medium">确认接入</n-button>
                </div>
            </n-form>
        </n-modal>

        <!-- 主面板（纯内容视图） -->
        <div class="bg-white/90 dark:bg-slate-900/90 backdrop-blur-xl rounded-3xl border border-slate-200/80 dark:border-slate-800/80 p-5 sm:p-7 shadow-sm space-y-6">
            <div class="flex items-center justify-between flex-wrap gap-4 pb-4 border-b border-slate-100 dark:border-slate-800/80">
                <div>
                    <h2 class="text-xl font-bold text-slate-900 dark:text-white tracking-tight">外部邮箱归集与同步 (IMAP)</h2>
                    <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">接入个人 QQ/163/Gmail 邮箱，由后台守护进程自动拉取并聚合至统一收件箱</p>
                </div>
                <n-button @click="showModal = true" type="primary" class="rounded-xl font-medium shadow-xs">
                    + 接入外部邮箱
                </n-button>
            </div>

            <div class="space-y-4">
                <n-data-table :columns="columns" :data="list" :loading="loading" :bordered="false" class="rounded-2xl overflow-hidden" />
            </div>
        </div>
    </div>
</template>
