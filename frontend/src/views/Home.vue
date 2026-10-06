<script setup>
import { computed, defineAsyncComponent } from 'vue'
import { useRoute } from 'vue-router'
import { useGlobalState } from '../store'

const Index = defineAsyncComponent(() => import('./Index.vue'))
const UnifiedInbox = defineAsyncComponent(() => import('./UnifiedInbox.vue'))

const route = useRoute()
const { userJwt } = useGlobalState()

const showTempMail = computed(() => {
  if (route.path.includes('/temp-mail')) return true
  if (userJwt.value && !route.query.tab && !route.query.mail_id) return false
  return Boolean(route.query.tab === 'temp' || route.query.mail_id)
})
</script>

<template>
  <component :is="showTempMail ? Index : UnifiedInbox" />
</template>
