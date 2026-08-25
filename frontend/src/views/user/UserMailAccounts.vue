<script setup>
import { ref, computed, onMounted, h } from 'vue';
import { useScopedI18n } from '@/i18n/app'
import { NButton, NTag, NPopconfirm, useMessage } from 'naive-ui'

import { useGlobalState } from '../../store'
import { api } from '../../api'

import Login from '../common/Login.vue';

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
    { label: 'QQ', value: 'imap_qq', host: 'imap.qq.com', port: 993 },
    { label: '163', value: 'imap_163', host: 'imap.163.com', port: 993 },
    { label: 'Custom', value: 'imap_custom', host: '', port: 993 },
]
const protocolOptions = computed(() => ([
    { label: t('auto'), value: 'auto' },
    { label: t('imap'), value: 'imap' },
    { label: t('pop3'), value: 'pop3' },
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
        message.error('required')
        return
    }
    submitting.value = true
    try {
        const folders = f.folders ? f.folders.split(',').map(s => s.trim()).filter(Boolean) : []
        await api.userMailAccounts.create(JSON.stringify({
            label: f.label, source: f.source, host: f.host, port: Number(f.port),
            username: f.username, cred: f.cred, protocol: f.protocol, folders,
        }))
        message.success(t('addSuccessTip'))
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

const fmtTime = (ms) => {
    if (!ms) return t('never')
    return new Date(ms).toLocaleString()
}

onMounted(async () => {
    if (userSettings.value.user_email) {
        await fetchData()
    }
})
</script>

<template>
    <div class="center" v-if="!userSettings.user_email">
        <Login />
    </div>
    <div v-else>
        <n-card :bordered="false" embedded style="max-width: 900px; margin: 0 auto;">
            <template #header>
                <span>{{ t('title') }}</span>
            </template>
            <template #header-extra>
                <n-button type="primary" @click="showModal = true">{{ t('addNew') }}</n-button>
            </template>

            <n-empty v-if="!loading && list.length === 0" :description="t('empty')" style="margin: 24px 0;" />
            <n-list v-else bordered>
                <n-list-item v-for="row in list" :key="row.id">
                    <n-thing>
                        <template #header>
                            {{ row.label || row.username }}
                            <span style="opacity: .6; margin-left: 8px;">{{ row.username }}</span>
                        </template>
                        <template #description>
                            <n-space size="small" align="center">
                                <n-tag size="small" :type="row.enabled ? 'success' : 'default'">
                                    {{ row.enabled ? t('enabled') : t('disabled') }}
                                </n-tag>
                                <n-tag size="small">{{ row.source }}</n-tag>
                                <n-tag size="small">{{ row.protocol }}</n-tag>
                                <span style="opacity: .6;">{{ row.host }}:{{ row.port }}</span>
                            </n-space>
                            <div style="opacity: .6; margin-top: 4px; font-size: 13px;">
                                {{ t('lastSync') }}: {{ fmtTime(row.last_sync_at) }}
                            </div>
                            <div v-if="row.last_error" style="color: #d03050; margin-top: 2px; font-size: 13px;">
                                {{ t('lastError') }}: {{ row.last_error }}
                            </div>
                        </template>
                        <template #action>
                            <n-space>
                                <n-button size="small" @click="toggle(row)">{{ t('toggle') }}</n-button>
                                <n-popconfirm @positive-click="remove(row)">
                                    <template #trigger>
                                        <n-button size="small" type="error">{{ t('delete') }}</n-button>
                                    </template>
                                    {{ t('deleteConfirm') }}
                                </n-popconfirm>
                            </n-space>
                        </template>
                    </n-thing>
                </n-list-item>
            </n-list>
        </n-card>

        <n-modal v-model:show="showModal" preset="card" style="max-width: 520px;"
            :title="t('addNew')">
            <n-form label-placement="top">
                <n-form-item :label="t('source')">
                    <n-select v-model:value="form.source" :options="sourceOptions"
                        @update:value="onSourceChange" />
                </n-form-item>
                <n-form-item :label="t('label')">
                    <n-input v-model:value="form.label" />
                </n-form-item>
                <n-form-item :label="t('username')">
                    <n-input v-model:value="form.username" placeholder="you@example.com" />
                </n-form-item>
                <n-form-item :label="t('cred')">
                    <n-input v-model:value="form.cred" type="password" show-password-on="click" />
                </n-form-item>
                <n-form-item :label="t('host')">
                    <n-input v-model:value="form.host" />
                </n-form-item>
                <n-form-item :label="t('port')">
                    <n-input-number v-model:value="form.port" :min="1" :max="65535" style="width: 100%;" />
                </n-form-item>
                <n-form-item :label="t('protocol')">
                    <n-select v-model:value="form.protocol" :options="protocolOptions" />
                </n-form-item>
                <n-form-item :label="t('folders')">
                    <n-input v-model:value="form.folders" placeholder="INBOX" />
                </n-form-item>
            </n-form>
            <template #footer>
                <n-space justify="end">
                    <n-button @click="showModal = false">{{ t('cancel') }}</n-button>
                    <n-button type="primary" :loading="submitting" @click="submit">{{ t('submit') }}</n-button>
                </n-space>
            </template>
        </n-modal>
    </div>
</template>

<style scoped>
.center {
    display: flex;
    text-align: center;
    place-items: center;
    justify-content: center;
}
</style>
