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

const sourceOptions = computed(() => ([
    { label: t('gmail'), value: 'imap_gmail', host: 'imap.gmail.com', port: 993, pop3Host: 'pop.gmail.com', pop3Port: 995 },
    { label: t('outlook'), value: 'imap_outlook', host: 'outlook.office365.com', port: 993, pop3Host: 'outlook.office365.com', pop3Port: 995 },
    { label: t('qq'), value: 'imap_qq', host: 'imap.qq.com', port: 993, pop3Host: 'pop.qq.com', pop3Port: 995 },
    { label: t('163'), value: 'imap_163', host: 'imap.163.com', port: 993, pop3Host: 'pop.163.com', pop3Port: 995 },
    { label: t('custom'), value: 'imap_custom', host: '', port: 993, pop3Host: '', pop3Port: 995 },
]))
const protocolOptions = computed(() => ([
    { label: t('auto') || '自动', value: 'auto' },
    { label: t('imap') || 'IMAP', value: 'imap' },
    { label: t('pop3') || 'POP3', value: 'pop3' },
]))

const form = ref(emptyForm())

function emptyForm() {
    return {
        label: '', source: 'imap_gmail', protocol: 'auto',
        host: 'imap.gmail.com', port: 993, use_ssl: true,
        pop3_host: 'pop.gmail.com', pop3_port: 995, pop3_ssl: true, pop3_use_stls: false,
        username: '', cred: '', folders: ''
    }
}

// The Worker requires the IMAP host/port fields for every account, including
// explicit POP3 accounts (POP3 is the fetch protocol, but the stored contract
// still requires the base endpoint). Keep these fields visible so POP3-only
// custom accounts can satisfy the real API validation instead of failing with
// an invisible required field.
const showImap = computed(() => true)
const showPop3 = computed(() => form.value.protocol !== 'imap')

const validPort = (value) => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 65535

const onSourceChange = (v) => {
    const opt = sourceOptions.value.find(o => o.value === v)
    if (!opt) return
    // A provider switch is a complete endpoint preset switch. Do not retain a
    // previous provider's POP3 endpoint (or port), especially when changing
    // between IMAP and POP3 modes.
    form.value.host = opt.host
    form.value.port = opt.port
    form.value.pop3_host = opt.pop3Host
    form.value.pop3_port = opt.pop3Port
}

const onProtocolChange = (v) => {
    if (v === 'pop3' && !form.value.pop3_host) {
        form.value.pop3_host = ''
        form.value.pop3_port = 995
    }
}

const fetchData = async () => {
    loading.value = true
    try {
        const res = await api.userMailAccounts.list()
        // Records created before protocol/POP3 support are IMAP accounts.
        list.value = (res.results || []).map(row => ({
            ...row,
            protocol: row.protocol || 'imap',
            use_ssl: row.use_ssl ?? true,
            pop3_ssl: row.pop3_ssl ?? true,
            pop3_use_stls: row.pop3_use_stls ?? false,
        }))
    } catch (e) {
        message.error(e.message || 'error')
    } finally {
        loading.value = false
    }
}

const submit = async () => {
    const f = form.value
    // Protocol-aware normalization:
    // 1. If protocol is 'pop3' and IMAP host/port was omitted, fallback to pop3 host/port.
    // 2. If protocol is 'auto' or 'imap', IMAP host/port is strictly required.
    // 3. For protocol 'auto', POP3 host is optional (aggregator will derive pop. from imap.).
    const effectiveHost = f.protocol === 'pop3' ? (f.host || f.pop3_host) : f.host
    const effectivePort = f.protocol === 'pop3' ? (f.port || f.pop3_port) : f.port
    const effectivePop3Host = f.protocol === 'pop3' ? (f.pop3_host || f.host) : f.pop3_host
    const effectivePop3Port = f.protocol === 'pop3' ? (f.pop3_port || f.port) : f.pop3_port

    const imapValid = effectiveHost && validPort(effectivePort)
    const pop3Valid = f.protocol !== 'pop3' || (effectivePop3Host && validPort(effectivePop3Port))
    if (!f.username || !f.cred || !imapValid || !pop3Valid) {
        message.error('请填写有效的邮箱服务器、端口与授权信息')
        return
    }
    if (![f.use_ssl, f.pop3_ssl, f.pop3_use_stls].every(v => typeof v === 'boolean')) {
        message.error('SSL/STLS 配置无效')
        return
    }
    submitting.value = true
    try {
        const folders = f.folders ? f.folders.split(',').map(s => s.trim()).filter(Boolean) : []
        await api.userMailAccounts.create({
            label: f.label, source: f.source, host: effectiveHost, port: Number(effectivePort), use_ssl: f.use_ssl,
            pop3_host: effectivePop3Host || null, pop3_port: effectivePop3Port ? Number(effectivePop3Port) : null,
            pop3_ssl: f.pop3_ssl, pop3_use_stls: f.pop3_use_stls, username: f.username, cred: f.cred,
            protocol: f.protocol, folders,
        })
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
    { title: t('protocol') || '协议', key: 'protocol', render(r) { return h(NTag, { type: r.protocol === 'pop3' ? 'warning' : 'info', size: 'small', round: true }, { default: () => r.protocol === 'auto' ? (t('auto') || '自动') : r.protocol.toUpperCase() }) } },
    { title: t('username') || '账号', key: 'username' },
    { title: t('host') || '服务器', key: 'host', render(r) {
        const host = r.protocol === 'pop3' ? (r.pop3_host || r.host) : r.host
        const port = r.protocol === 'pop3' ? (r.pop3_port || r.port) : r.port
        return `${host}:${port}`
    } },
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
        title: t('lastError') || '最近错误',
        key: 'last_error',
        render(r) {
            return r.last_error
                ? h(NTag, { type: 'error', size: 'small', title: r.last_error }, { default: () => r.last_error })
                : h('span', { class: 'text-slate-400' }, '—')
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
        <n-modal v-model:show="showModal" preset="card" :title="t('modalTitle') || '添加外部邮箱归集 (IMAP/POP3)'" class="rounded-3xl max-w-lg">
            <n-form :model="form" label-placement="top" class="space-y-3">
                <n-form-item :label="t('emailType') || '邮箱服务商'">
                    <n-select v-model:value="form.source" :options="sourceOptions" @update:value="onSourceChange" class="rounded-xl" />
                </n-form-item>
                <n-form-item :label="t('protocol') || '协议'">
                    <n-select v-model:value="form.protocol" :options="protocolOptions" @update:value="onProtocolChange" class="rounded-xl" />
                </n-form-item>
                <n-form-item :label="t('customLabel') || '自定义标签（选填）'">
                    <n-input v-model:value="form.label" placeholder="如：我的个人 QQ 邮箱" class="rounded-xl" />
                </n-form-item>
                <n-form-item :label="t('emailUsername') || '邮箱地址 / 用户名'">
                    <n-input v-model:value="form.username" placeholder="user@example.com" class="rounded-xl" />
                </n-form-item>
                <n-form-item :label="t('credential') || '授权码 / 应用专用密码'">
                    <n-input v-model:value="form.cred" type="password" show-password-on="click" placeholder="应用专用密码或授权码" class="rounded-xl" />
                </n-form-item>
                <p v-if="form.protocol === 'auto'" class="text-xs text-slate-500 dark:text-slate-400">
                    {{ t('autoDescription') || '自动：优先使用 IMAP；IMAP 失败时仅对 INBOX 使用 POP3 fallback。' }}
                </p>
                <p v-else-if="form.protocol === 'pop3'" class="text-xs text-slate-500 dark:text-slate-400">
                    {{ t('pop3OnlyDescription') || 'POP3-only：仅同步 INBOX；IMAP 主机与端口仍需按接口要求填写。' }}
                </p>
                <template v-if="showPop3">
                    <div class="grid grid-cols-2 gap-3">
                        <n-form-item :label="t('pop3Host') || 'POP3 主机'">
                            <n-input v-model:value="form.pop3_host" placeholder="pop.example.com" class="rounded-xl" />
                        </n-form-item>
                        <n-form-item :label="t('pop3Port') || 'POP3 端口'">
                            <n-input-number v-model:value="form.pop3_port" :min="1" :max="65535" class="rounded-xl w-full" />
                        </n-form-item>
                    </div>
                    <div class="flex gap-6">
                        <n-checkbox v-model:checked="form.pop3_ssl">{{ t('pop3Ssl') || 'POP3 SSL' }}</n-checkbox>
                        <n-checkbox v-model:checked="form.pop3_use_stls">{{ t('pop3Stls') || 'POP3 STLS' }}</n-checkbox>
                    </div>
                </template>
                <template v-if="showImap">
                    <div class="grid grid-cols-2 gap-3">
                        <n-form-item :label="t('imapHost') || 'IMAP 主机'">
                            <n-input v-model:value="form.host" placeholder="imap.example.com" class="rounded-xl" />
                        </n-form-item>
                        <n-form-item :label="t('port') || 'IMAP 端口'">
                            <n-input-number v-model:value="form.port" :min="1" :max="65535" class="rounded-xl w-full" />
                        </n-form-item>
                    </div>
                    <n-checkbox v-model:checked="form.use_ssl">{{ t('imapSsl') || 'IMAP SSL' }}</n-checkbox>
                </template>
                <n-form-item v-if="form.protocol !== 'pop3'" :label="t('folders') || '文件夹（逗号分隔，默认 INBOX）'">
                    <n-input v-model:value="form.folders" placeholder="INBOX, Archive" class="rounded-xl" />
                </n-form-item>
                <div class="flex justify-end gap-3 pt-4">
                    <n-button @click="showModal = false" class="rounded-xl">{{ t('cancelAction') || '取消' }}</n-button>
                    <n-button type="primary" :loading="submitting" @click="submit" class="rounded-xl px-5 font-medium">{{ t('confirm') || '确认接入' }}</n-button>
                </div>
            </n-form>
        </n-modal>

        <!-- 主面板（纯内容视图） -->
        <div class="bg-white/90 dark:bg-slate-900/90 backdrop-blur-xl rounded-3xl border border-slate-200/80 dark:border-slate-800/80 p-5 sm:p-7 shadow-sm space-y-6">
            <div class="flex items-center justify-between flex-wrap gap-4 pb-4 border-b border-slate-100 dark:border-slate-800/80">
                <div>
                    <h2 class="text-xl font-bold text-slate-900 dark:text-white tracking-tight">{{ t('title') || '外部邮箱归集与同步 (IMAP/POP3)' }}</h2>
                    <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{{ t('description') || '由后台聚合器自动拉取邮件并归集到统一收件箱。' }}</p>
                </div>
                <n-button @click="showModal = true" type="primary" class="rounded-xl font-medium shadow-xs">
                    + {{ t('connect') || '接入外部邮箱' }}
                </n-button>
            </div>

            <div class="space-y-4">
                <n-data-table :columns="columns" :data="list" :loading="loading" :bordered="false" class="rounded-2xl overflow-hidden" />
            </div>
        </div>
    </div>
</template>
