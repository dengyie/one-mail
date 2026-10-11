<script setup lang="ts">
import { useMessage } from 'naive-ui'
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useScopedI18n } from '@/i18n/app'
import { api } from '../../api'

const message = useMessage()
const controller = new AbortController()
const { t } = useScopedI18n('views.admin.ShardMaintenance')

type ShardEntry = {
    id: string
    base_url: string
    account_ids: string[]
    reachable: boolean
    unavailable_reason: string | null
    reported_shard_id: string | null
    shard_mode: boolean | null
}

type ShardList = {
    primary: { shard_id: string; is_shard_mode: boolean }
    shards: ShardEntry[]
    registry_error: string | null
}

const shardList = ref<ShardList | null>(null)
const loading = ref(false)
const errorMessage = ref('')
const busyId = ref('')

const isShardList = (value: unknown): value is ShardList => {
    if (!value || typeof value !== 'object') return false
    const list = value as Record<string, unknown>
    const primary = list.primary
    if (!primary || typeof primary !== 'object') return false
    if (typeof (primary as Record<string, unknown>).shard_id !== 'string') return false
    if (typeof (primary as Record<string, unknown>).is_shard_mode !== 'boolean') return false
    if (list.registry_error !== null && typeof list.registry_error !== 'string') return false
    if (!Array.isArray(list.shards)) return false
    return list.shards.every((shard: unknown) => {
        if (!shard || typeof shard !== 'object') return false
        const entry = shard as Record<string, unknown>
        return typeof entry.id === 'string' && entry.id.length > 0
            && typeof entry.base_url === 'string'
            && Array.isArray(entry.account_ids)
            && entry.account_ids.every((accountId: unknown) => typeof accountId === 'string')
            && typeof entry.reachable === 'boolean'
            && (entry.unavailable_reason === null || typeof entry.unavailable_reason === 'string')
    })
}

async function loadShards(): Promise<void> {
    if (loading.value || controller.signal.aborted) return
    loading.value = true
    errorMessage.value = ''
    try {
        const list: unknown = await api.fetch('/admin/db_shards', { signal: controller.signal })
        if (controller.signal.aborted) return
        if (!isShardList(list)) throw new Error(t('invalidShardList'))
        shardList.value = list
    } catch (error) {
        if (controller.signal.aborted) return
        shardList.value = null
        errorMessage.value = error instanceof Error ? error.message : String(error)
    } finally {
        loading.value = false
    }
}

async function runInitialize(shardId: string): Promise<void> {
    if (busyId.value || controller.signal.aborted) return
    busyId.value = shardId
    try {
        await api.fetch('/admin/db_shard_initialize', {
            method: 'POST',
            body: { shard_id: shardId },
            signal: controller.signal,
        })
        if (controller.signal.aborted) return
        message.success(t('initializeSuccess', { id: shardId }))
        await loadShards()
    } catch (error) {
        if (controller.signal.aborted) return
        const reason = error instanceof Error ? error.message : String(error)
        message.error(t('initializeFailed', { id: shardId, reason }))
    } finally {
        busyId.value = ''
    }
}

onMounted(() => loadShards())
onBeforeUnmount(() => controller.abort())
</script>


<template>
    <div class="space-y-4">
        <div class="flex items-center justify-between">
            <div>
                <p class="text-sm font-semibold text-slate-900 dark:text-white">{{ t('sectionTitle') }}</p>
                <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{{ t('sectionHint') }}</p>
            </div>
            <n-button quaternary size="tiny" :loading="loading" :disabled="loading" @click="loadShards()">
                {{ t('refresh') }}
            </n-button>
        </div>

        <template v-if="errorMessage">
            <n-alert type="error" :show-icon="false" :bordered="false">
                <p>{{ errorMessage }}</p>
            </n-alert>
        </template>

        <p v-else-if="!shardList" role="status" class="text-sm text-slate-500 dark:text-slate-400">
            {{ t('loading') }}
        </p>

        <template v-else>
            <n-alert v-if="shardList.registry_error" type="warning" :show-icon="false" :bordered="false">
                <span>{{ t('registryError') }}</span>
            </n-alert>
            <p v-else-if="shardList.shards.length === 0" class="text-sm text-slate-500 dark:text-slate-400">
                {{ t('noShards') }}
            </p>
            <div v-else class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div v-for="shard in shardList.shards" :key="shard.id"
                     class="p-5 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/60 space-y-2">
                    <div class="flex items-center justify-between gap-2">
                        <p class="text-sm font-bold text-slate-900 dark:text-white font-mono">{{ shard.id }}</p>
                        <n-tag :type="shard.reachable ? 'success' : 'warning'" size="small" :bordered="false">
                            {{ shard.reachable ? t('reachable') : t('unreachable', { reason: shard.unavailable_reason ?? '' }) }}
                        </n-tag>
                    </div>
                    <p class="text-xs text-slate-500 dark:text-slate-400 break-all">{{ shard.base_url }}</p>
                    <p class="text-xs text-slate-500 dark:text-slate-400">
                        {{ t('assignedAccounts', { count: shard.account_ids.length }) }}
                    </p>
                    <n-button type="primary" secondary block :loading="busyId === shard.id"
                              :disabled="!!busyId || !shard.reachable" @click="runInitialize(shard.id)">
                        {{ t('initialize') }}
                    </n-button>
                </div>
            </div>
        </template>
    </div>
</template>
