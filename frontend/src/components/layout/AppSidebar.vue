<script setup>
import { computed, ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useScopedI18n } from '@/i18n/app'
import { useGlobalState } from '../../store'
import { getRouterPathWithLang } from '../../utils'
import { clearLocalAddressCache } from '../../utils/address-cache'
import MailIcon from '../ui/MailIcon.vue'

const props = defineProps({ collapsed: Boolean, mobile: Boolean })
const emit = defineEmits(['update:collapsed', 'navigate', 'close'])
const route = useRoute()
const router = useRouter()
const { t, locale } = useScopedI18n('workspace')
const { t: headerT } = useScopedI18n('views.Header')
const {
  settings, userSettings, openSettings, showAdminPage, userJwt, jwt, auth, adminAuth, addressPassword,
  userOauth2SessionState, userOauth2SessionClientID, unifiedApiKey, hasUserSession,
} = useGlobalState()
const hasAddressSession = computed(() => Boolean(jwt.value))
const isLoggedIn = computed(() => hasUserSession.value || hasAddressSession.value || showAdminPage.value || Boolean(unifiedApiKey.value))
const canUseDomainMailbox = computed(() => Boolean(userSettings.value.is_admin || adminAuth.value || (unifiedApiKey.value && !hasUserSession.value)))
const canCompose = computed(() => openSettings.value.enableSendMail && (hasAddressSession.value || hasUserSession.value || Boolean(userSettings.value.is_admin || adminAuth.value)))
const showLogout = ref(false)
const requestLogout = () => { showLogout.value = true }
const handleLogout = async () => {
  // Clear every credential channel, including cached address JWTs, before
  // navigating so a shared browser cannot keep using the previous session.
  userJwt.value = ''
  jwt.value = ''
  auth.value = ''
  adminAuth.value = ''
  addressPassword.value = ''
  userOauth2SessionState.value = ''
  userOauth2SessionClientID.value = ''
  unifiedApiKey.value = ''
  settings.value = {
    fetched: true,
    send_balance: 0,
    address: '',
    auto_reply: {
      subject: '',
      message: '',
      enabled: false,
      source_prefix: '',
      name: '',
    },
  }
  userSettings.value = { fetched: true, user_email: '', user_id: 0, is_admin: false, access_token: null, new_user_token: null, user_role: null }
  clearLocalAddressCache()
  showLogout.value = false
  await router.push(getRouterPathWithLang('/', locale.value))
  emit('navigate')
}


const navGroups = computed(() => {
  const mail = [
    { label: 'inbox', icon: 'inbox', path: '/unified', key: 'inbox' },
    { label: 'starred', icon: 'star', path: '/unified?view=starred', key: 'starred' },
    { label: 'unread', icon: 'mail', path: '/unified?view=unread', key: 'unread' },
    { label: 'codes', icon: 'key', path: '/unified?tab=codes', key: 'codes' },
  ]
  if (!hasUserSession.value) mail.push({ label: 'tempMail', icon: 'clock', path: '/temp-mail', key: 'tempMail' })
  if (canUseDomainMailbox.value) mail.push({ label: 'domainMailbox', icon: 'domain', path: '/domain-mailbox', key: 'domainMailbox' })
  const groups = [{ label: 'mail', items: mail }]
  const manage = []
  if (hasUserSession.value) {
    manage.push(
      { label: 'accounts', icon: 'accounts', path: '/user/external-accounts', key: 'accounts' },
      { label: 'addresses', icon: 'address', path: '/user/addresses', key: 'addresses' },
      { label: 'security', icon: 'shield', path: '/user/settings', key: 'security' },
    )
  }
  if (hasAddressSession.value && openSettings.value.enableWebhook) manage.push({ label: 'webhook', icon: 'git-branch', path: '/webhook', key: 'webhook' })
  manage.push({ label: 'appearance', icon: 'palette', path: '/user/appearance', key: 'appearance' })
  groups.push({ label: 'manage', items: manage })
  if (showAdminPage.value) groups.push({ label: 'admin', items: [
    ['adminAccounts', 'accounts', 'accounts'], ['adminUsers', 'users', 'users'], ['adminStats', 'chart', 'statistics'],
    ['adminAi', 'sparkles', 'ai-extract'], ['webhook', 'git-branch', 'webhook'], ['adminDatabase', 'database', 'database'],
    ['adminSettings', 'settings', 'settings'], ['adminSendAccess', 'key', 'sender-access'], ['adminSend', 'send', 'sendmail'],
    ['adminHistory', 'archive', 'sendbox'], ['adminUnknown', 'clock', 'send-unknown'],
  ].map(([label, icon, path]) => ({ label, icon, path: '/admin/' + path, key: 'admin-' + path })) })
  return groups
})
const isActive = (item) => {
  const path = route.path.replace(/^\/(en|zh|es|pt-BR|ja|de)(?=\/|$)/, '') || '/'
  if (path === '/unified' || path === '/' || path.startsWith('/unified/')) {
    if (route.query.tab === 'codes') return item.key === 'codes'
    if (route.query.view === 'starred') return item.key === 'starred'
    if (route.query.view === 'unread') return item.key === 'unread'
    return item.key === 'inbox'
  }
  return path === item.path.split('?')[0] || (path === '/user' && item.key === 'addresses') || (path === '/admin' && item.key === 'admin-accounts')
}
const profileLabel = computed(() => userSettings.value.user_email || settings.value.address || t('administrator'))
</script>

<template>
  <aside class="mail-sidebar" :class="{ 'is-collapsed': collapsed }">
    <div class="flex items-center justify-between">
      <RouterLink class="mail-brand" :to="getRouterPathWithLang('/unified', locale)" @click="emit('navigate')" aria-label="One Mail">
        <img src="/logo.png" alt="" width="32" height="32" />
        <span v-if="!collapsed" class="mail-brand__name">one<span>mail</span></span>
      </RouterLink>
      <button v-if="mobile" type="button" class="mail-icon-button mr-3" :aria-label="t('closeMenu')" @click="emit('close')"><MailIcon name="x" :size="18" /></button>
    </div>
    <RouterLink v-if="canCompose" class="mail-compose" :to="getRouterPathWithLang('/sendmail', locale)" :title="t('compose')" @click="emit('navigate')">
      <MailIcon name="compose" :size="18" /><span v-if="!collapsed">{{ t('compose') }}</span>
    </RouterLink>
    <RouterLink v-else class="mail-compose" :to="getRouterPathWithLang(isLoggedIn ? '/unified' : '/user', locale)" @click="emit('navigate')" :title="t(isLoggedIn ? 'inbox' : 'login')">
      <MailIcon :name="isLoggedIn ? 'inbox' : 'arrow-right'" :size="18" /><span v-if="!collapsed">{{ t(isLoggedIn ? 'inbox' : 'login') }}</span>
    </RouterLink>
    <nav class="mail-navigation" :aria-label="t('workspace')">
      <div v-for="group in navGroups" :key="group.label" class="mail-nav-group">
        <div v-if="!collapsed" class="mail-nav-heading">{{ t(group.label) }}</div>
        <RouterLink v-for="item in group.items" :key="item.key" :to="getRouterPathWithLang(item.path, locale)" class="mail-nav-link" :class="{ 'is-active': isActive(item) }" :aria-current="isActive(item) ? 'page' : undefined" :title="collapsed ? t(item.label) : undefined" @click="emit('navigate')">
          <MailIcon :name="item.icon" :size="18" />
          <span v-if="!collapsed" class="mail-nav-link__label">{{ t(item.label) }}</span>
          <span v-if="!collapsed && isActive(item)" class="mail-nav-link__hint" aria-hidden="true"></span>
        </RouterLink>
      </div>
    </nav>
    <div class="mail-sidebar__bottom">
      <div v-if="isLoggedIn" class="mail-profile">
        <RouterLink :to="getRouterPathWithLang('/user', locale)" class="mail-avatar" :aria-label="t('account')" @click="emit('navigate')">{{ profileLabel[0]?.toUpperCase() }}</RouterLink>
        <div v-if="!collapsed" class="mail-profile__info"><span class="mail-profile__name">{{ profileLabel }}</span><span class="mail-profile__role">{{ t(showAdminPage ? 'administrator' : 'member') }}</span></div>
        <button type="button" class="mail-icon-button" @click="requestLogout" :aria-label="t('logout')" :title="t('logout')"><MailIcon name="logout" :size="17" /></button>
      </div>
      <div v-else-if="!collapsed" class="mail-sidebar__guest"><p>{{ t('guestHint') }}</p><RouterLink :to="getRouterPathWithLang('/user', locale)" @click="emit('navigate')">{{ t('login') }}<MailIcon name="arrow-right" :size="14" /></RouterLink></div>
    </div>
    <n-modal v-model:show="showLogout" preset="dialog" :title="t('logout')">
      <p>{{ headerT('logoutConfirm') }}</p>
      <template #action><n-button @click="handleLogout" type="primary">{{ t('logout') }}</n-button></template>
    </n-modal>
  </aside>
</template>
