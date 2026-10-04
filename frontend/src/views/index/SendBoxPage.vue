<script setup>
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useScopedI18n } from '@/i18n/app'
import { getRouterPathWithLang } from '../../utils'

const router = useRouter()
const { locale } = useScopedI18n('views.Header')

onMounted(() => {
  const homePath = getRouterPathWithLang('/', locale)
  router.replace({
    path: getRouterPathWithLang('/sendmail', locale.value) || homePath,
    query: { tab: 'self' },
  })
})
</script>

<template>
  <div />
</template>
