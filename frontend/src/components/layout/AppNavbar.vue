<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useScopedI18n } from '@/i18n/app'
import { Github } from '@vicons/fa'
import { useGlobalState } from '../../store'
import { getRouterPathWithLang } from '../../utils'
import { SUPPORTED_LOCALES, getLocaleLabel } from '../../i18n/locale-registry'
import { isSupportedLocale, replaceLocaleInFullPath, DEFAULT_LOCALE } from '../../i18n/utils'
import ThemeToggle from '../ai/ThemeToggle.vue'
import MailIcon from '../ui/MailIcon.vue'

const props = defineProps({ sidebarCollapsed: Boolean })
const emit = defineEmits(['toggle-sidebar', 'open-mobile-menu'])
const route = useRoute()
const router = useRouter()
const { t, locale } = useScopedI18n('workspace')
const { userSettings, openSettings, showAdminPage, preferredLocale } = useGlobalState()
const searchInput = ref(null)
const query = ref('')
watch(() => route.query.q, value => { query.value = typeof value === 'string' ? value : '' }, { immediate: true })
const searchMail = () => router.push({ path: getRouterPathWithLang('/unified', locale.value), query: query.value.trim() ? { q: query.value.trim() } : {} })
const currentTitle = computed(() => {
  const path = route.path
  if (path.includes('/admin')) return t('admin')
  if (path.includes('/domain-mailbox')) return t('domainMailbox')
  if (path.includes('/sendmail') || path.includes('/sendbox')) return t('sendWorkspace')
  if (path.includes('/user/external-accounts')) return t('accounts')
  if (path.includes('/user/appearance')) return t('appearance')
  if (path.includes('/user/settings')) return t('security')
  if (path.includes('/user')) return t('account')
  if (path.includes('/temp-mail')) return t('tempMail')
  if (path.includes('/webhook')) return t('webhook')
  return t('inbox')
})
const languageOptions = SUPPORTED_LOCALES.map(loc => ({ label: getLocaleLabel(loc), key: loc }))
const changeLocale = async (lang) => {
  if (!isSupportedLocale(lang)) return
  if (lang === DEFAULT_LOCALE) preferredLocale.value = DEFAULT_LOCALE
  await router.push(replaceLocaleInFullPath(route.fullPath, lang))
  preferredLocale.value = lang
}
const showGithub = computed(() => openSettings.value.showGithub && (openSettings.value.showGithubForUser || showAdminPage.value))
const onShortcut = (event) => {
  const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName))
  if (((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') || (!typing && !event.metaKey && !event.ctrlKey && event.key === '/')) {
    event.preventDefault()
    searchInput.value?.focus()
  }
}
onMounted(() => window.addEventListener('keydown', onShortcut))
onBeforeUnmount(() => window.removeEventListener('keydown', onShortcut))
</script>

<template>
  <header class="mail-navbar">
    <div class="mail-navbar__left">
      <button type="button" class="mail-icon-button mail-desktop-menu" @click="emit('toggle-sidebar')" :title="t(sidebarCollapsed ? 'expandSidebar' : 'collapseSidebar')" :aria-label="t(sidebarCollapsed ? 'expandSidebar' : 'collapseSidebar')" :aria-expanded="!sidebarCollapsed"><MailIcon name="menu" :size="19" /></button>
      <button type="button" class="mail-icon-button mail-mobile-menu" @click="emit('open-mobile-menu')" :aria-label="t('openMenu')"><MailIcon name="menu" :size="21" /></button>
      <div class="mail-breadcrumb"><span>{{ t('workspace') }}</span><MailIcon name="chevron-right" :size="12" /><strong>{{ currentTitle }}</strong></div>
      <form class="mail-global-search" role="search" @submit.prevent="searchMail">
        <MailIcon name="search" :size="15" />
        <input ref="searchInput" v-model="query" type="search" :aria-label="t('search')" :placeholder="t('searchPlaceholder')" />
        <kbd aria-hidden="true">/</kbd>
      </form>
    </div>
    <div class="mail-navbar__actions">
      <ThemeToggle />
      <n-dropdown :options="languageOptions" @select="changeLocale" trigger="click">
        <button type="button" class="mail-icon-button" :aria-label="t('changeLanguage')" :title="t('changeLanguage')"><MailIcon name="globe" :size="17" /></button>
      </n-dropdown>
      <a v-if="showGithub" href="https://github.com/dengyie/one-mail" target="_blank" rel="noopener noreferrer" class="mail-icon-button mail-navbar__github" title="GitHub" aria-label="GitHub"><Github width="17" height="17" /></a>
      <span class="mail-navbar__divider" aria-hidden="true"></span>
      <RouterLink v-if="userSettings.user_email" :to="getRouterPathWithLang('/user', locale)" class="mail-avatar mail-navbar__avatar" :aria-label="t('account')">{{ userSettings.user_email[0]?.toUpperCase() }}</RouterLink>
      <RouterLink v-else :to="getRouterPathWithLang('/user', locale)" class="mail-navbar__login">{{ t('login') }}</RouterLink>
    </div>
  </header>
</template>
