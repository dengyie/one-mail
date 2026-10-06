<script setup>
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useScopedI18n } from '@/i18n/app'
import { getRouterPathWithLang } from '../../utils'

const router = useRouter()
const { locale } = useScopedI18n('views.Header')

onMounted(() => {
  const fallbackPath = getRouterPathWithLang('/unified', locale.value)
  router.replace({
    path: getRouterPathWithLang('/sendmail', locale.value) || fallbackPath,
    query: { tab: 'self' },
  })
})
</script>

<template>
  <div />
</template>
