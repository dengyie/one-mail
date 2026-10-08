<script setup lang="ts">
import { useMessage } from 'naive-ui'
import { ref, onMounted, onBeforeUnmount } from 'vue'
import type { DatabaseStatus } from '@one-mail/shared'
import { useScopedI18n } from '@/i18n/app'
import { api } from '../../api'

const message = useMessage()
const dbVersionData = ref<DatabaseStatus | null>(null)
const loading = ref(false)
const errorMessage = ref('')
const controller = new AbortController()
const { t } = useScopedI18n('views.admin.DatabaseManager')

const actions = {
    initialize: { path: '/admin/db_initialize', success: 'initializationSuccess' },
    migrate: { path: '/admin/db_migration', success: 'migrationSuccess' },
} as const

function isDatabaseStatus(value: unknown): value is DatabaseStatus {
    if (!value || typeof value !== 'object') return false
    const status = value as Record<string, unknown>
    return typeof status.need_initialization === 'boolean'
        && typeof status.need_migration === 'boolean'
        && !(status.need_initialization && status.need_migration)
        && (status.current_db_version === null || typeof status.current_db_version === 'string')
        && typeof status.code_db_version === 'string' && status.code_db_version.length > 0
}

async function runAction(actionName?: keyof typeof actions): Promise<void> {
    if (loading.value || controller.signal.aborted) return
    const action = actionName ? actions[actionName] : undefined
    if (action && !dbVersionData.value) return
    loading.value = true
    errorMessage.value = ''
    try {
        if (action) await api.fetch(action.path, { method: 'POST', signal: controller.signal })
        if (controller.signal.aborted) return
        const status: unknown = await api.fetch('/admin/db_version', { signal: controller.signal })
        if (controller.signal.aborted) return
        if (!isDatabaseStatus(status)) throw new Error(t('invalidStatus'))
        if (action && (status.need_initialization || status.need_migration)) throw new Error(t('statusNotCurrent'))
        dbVersionData.value = status
        if (action) message.success(t(action.success))
    } catch (error) {
        if (controller.signal.aborted) return
        dbVersionData.value = null
        errorMessage.value = error instanceof Error ? error.message : String(error)
    } finally {
        loading.value = false
    }
}

onMounted(() => runAction())
onBeforeUnmount(() => controller.abort())
</script>


<template>
    <div class="center">
        <n-card :bordered="false" embedded :aria-busy="loading">
            <n-alert v-if="errorMessage" type="error" :show-icon="false" :bordered="false">
                <p>{{ errorMessage }}</p>
                <n-button @click="runAction()" :loading="loading" :disabled="loading">
                    {{ t('retry') }}
                </n-button>
            </n-alert>
            <template v-else-if="dbVersionData">
                <n-alert v-if="dbVersionData.need_initialization" type="warning" :show-icon="false" :bordered="false">
                    <span>{{ t('need_initialization_tip') }}</span>
                    <n-button @click="runAction('initialize')" type="primary" secondary block :loading="loading" :disabled="loading">
                        {{ t('init') }}
                    </n-button>
                </n-alert>
                <n-alert v-if="dbVersionData.need_migration" type="warning" :show-icon="false" :bordered="false">
                    <span>{{ t('need_migration_tip') }}</span>
                    <n-button @click="runAction('migrate')" type="primary" secondary block :loading="loading" :disabled="loading">
                        {{ t('migration') }}
                    </n-button>
                </n-alert>
                <n-alert type="info" :show-icon="false" :bordered="false">
                    <span>
                        {{ t('current_db_version') }}: {{ dbVersionData.current_db_version || "unknown" }},
                        {{ t('code_db_version') }}: {{ dbVersionData.code_db_version }}
                    </span>
                </n-alert>
            </template>
            <p v-else role="status">{{ t('loading') }}</p>
        </n-card>
    </div>
</template>

<style scoped>
.n-card {
    max-width: 800px;
}

.n-alert {
    margin-bottom: 10px;
}

.center {
    display: flex;
    text-align: center;
    place-items: center;
    justify-content: center;
}

.n-button {
    margin-top: 10px;
}
</style>
