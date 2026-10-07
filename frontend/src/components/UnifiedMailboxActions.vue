<template>
  <div v-if="canMove || canDelete" class="flex items-center gap-2">
    <template v-if="canMove">
      <n-select
        v-model:value="targetFolderId"
        size="small"
        class="w-40"
        :options="folderOptions"
        :loading="loadingFolders"
        :disabled="busy || !folderOptions.length"
        placeholder="移动到…"
        clearable
      />
      <n-button
        size="small"
        secondary
        :loading="moving"
        :disabled="busy || !targetFolderId"
        @click="move"
      >
        移动
      </n-button>
    </template>

    <n-button
      v-if="canDelete"
      size="small"
      secondary
      type="error"
      :loading="deleting"
      :disabled="busy"
      @click="remove"
    >
      删除
    </n-button>
  </div>
</template>

<script setup>
import { computed, ref, watch, onBeforeUnmount, onActivated, onDeactivated } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'

import { api } from '../api'
import { useGlobalState } from '../store'

const props = defineProps({
  email: {
    type: Object,
    required: true,
  },
})

const router = useRouter()
const message = useMessage()
const folders = ref([])
const targetFolderId = ref(null)
const loadingFolders = ref(false)
const moving = ref(false)
const deleting = ref(false)
const busy = computed(() => moving.value || deleting.value)

const provider = computed(() => {
  const explicit = String(props.email?.provider || '').trim().toLowerCase()
  if (explicit) return explicit
  const source = String(props.email?.source || '').trim().toLowerCase()
  if (source === 'cf_routing' || source === 'cloudflare') return 'native'
  if (source === 'graph_outlook') return 'graph'
  if (source.startsWith('imap_')) return 'imap'
  if (source.startsWith('pop3_')) return 'pop3'
  return 'unknown'
})

const canMove = computed(() =>
  !!props.email?.account_id && (provider.value === 'imap' || provider.value === 'graph'))
const canDelete = computed(() => ['native', 'imap', 'graph'].includes(provider.value))

const folderOptions = computed(() => folders.value
  .filter((folder) => {
    if (folder.provider !== provider.value) return false
    if (props.email?.source_folder_id && folder.provider_folder_id) {
      return folder.provider_folder_id !== props.email.source_folder_id
    }
    return folder.canonical_name !== props.email?.source_folder
  })
  .map((folder) => ({
    label: folder.display_name || folder.canonical_name,
    value: folder.id,
  })))

const { userJwt, adminAuth, unifiedApiKey } = useGlobalState()
let controller = new AbortController()
const current = scope => scope === controller && !scope.signal.aborted
let folderRequestSeq = 0
const loadFolders = async () => {
  const requestId = ++folderRequestSeq
  const scope = controller
  targetFolderId.value = null
  folders.value = []
  loadingFolders.value = false
  if (!canMove.value || scope.signal.aborted) return
  loadingFolders.value = true
  try {
    const result = await api.unified.listFolders({ account_id: props.email.account_id }, { signal: scope.signal })
    if (requestId !== folderRequestSeq || !current(scope)) return
    folders.value = Array.isArray(result?.results) ? result.results : []
  } catch (error) {
    if (requestId !== folderRequestSeq || !current(scope)) return
    message.error(error?.message || '文件夹加载失败')
  } finally {
    if (requestId === folderRequestSeq && current(scope)) loadingFolders.value = false
  }
}

const renewScope = () => {
  controller.abort()
  controller = new AbortController()
  moving.value = false
  deleting.value = false
  void loadFolders()
}
watch([() => props.email, () => props.email?.id, () => props.email?.account_id, provider, userJwt, adminAuth, unifiedApiKey], renewScope, { immediate: true })
onBeforeUnmount(() => controller.abort())
onDeactivated(() => controller.abort())
onActivated(() => { if (controller.signal.aborted) renewScope() })

const move = async () => {
  if (!canMove.value || !targetFolderId.value || busy.value) return
  const scope = controller
  const target = props.email
  moving.value = true
  try {
    const result = await api.unified.moveEmail(target.id, targetFolderId.value, { signal: scope.signal })
    if (!current(scope) || props.email !== target) return
    // Provider terminal state is awaited by the unified API. Only now is it safe to update what the UI displays.
    props.email.source_folder = result.source_folder ?? props.email.source_folder
    props.email.source_folder_id = result.source_folder_id ?? props.email.source_folder_id
    message.success(`已移动到 ${props.email.source_folder || '目标文件夹'}`)
    await loadFolders()
  } catch (error) {
    if (current(scope)) message.error(error?.message || '移动失败')
  } finally {
    if (current(scope)) moving.value = false
  }
}

const remove = async () => {
  if (!canDelete.value || busy.value) return
  if (!window.confirm('确定要删除这封邮件吗？外部邮箱会同步执行删除。')) return
  const scope = controller
  deleting.value = true
  try {
    await api.unified.deleteEmail(props.email.id, { signal: scope.signal })
    if (!current(scope)) return
    message.success('邮件已删除')
    await router.push('/unified')
  } catch (error) {
    if (current(scope)) message.error(error?.message || '删除失败')
  } finally {
    if (current(scope)) deleting.value = false
  }
}
</script>