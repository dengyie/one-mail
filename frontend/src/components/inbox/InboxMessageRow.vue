<script setup>
import { computed } from 'vue'
import { useScopedI18n } from '../../i18n/app'
import MailIcon from '../ui/MailIcon.vue'

const props = defineProps({ email: { type: Object, required: true }, code: String, timeLabel: String, fullTime: String, busy: Boolean })
const emit = defineEmits(['open', 'star', 'read', 'copy-code'])
const { t } = useScopedI18n('workspace')
const senderName = computed(() => {
  const value = String(props.email.from_addr || '')
  return value.includes('<') ? value.split('<')[0].replace(/^"|"$/g, '').trim() || value : value.split('@')[0]
})
const tone = computed(() => [...String(props.email.from_addr || '')].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 5)
const sources = { imap_gmail: 'Gmail', imap_outlook: 'Outlook', graph_outlook: 'Outlook', imap_qq: 'QQ', imap_163: '163', cloudflare: 'Cloudflare', cf_routing: 'Cloudflare' }
</script>

<template>
  <article class="inbox-message" :class="{ 'is-unread': !email.is_read }" :data-mail-id="email.id" @click="emit('open', email.id)">
    <div class="inbox-sender-avatar" :class="`tone-${tone}`" aria-hidden="true">{{ (senderName[0] || '?').toUpperCase() }}</div>
    <div class="inbox-message__body">
      <div class="inbox-message__sender" :title="email.from_addr"><span>{{ senderName }}</span><span v-if="!email.is_read" class="inbox-message__unread" :aria-label="t('unread')"></span></div>
      <h3 class="inbox-message__subject"><button type="button" class="inbox-message__open" @click.stop="emit('open', email.id)">{{ email.subject || t('noSubject') }}</button></h3>
      <div class="inbox-message__meta">
        <span class="inbox-source">{{ sources[email.source] || email.source }}</span>
        <span class="inbox-message__account" :title="email.to_addr || email.account_id">{{ email.to_addr || email.account_id }}</span>
        <button v-if="code" type="button" class="inbox-code" :aria-label="`${t('copyCode')} ${code}`" @click.stop="emit('copy-code', code)"><MailIcon name="copy" :size="11" />{{ code }}</button>
      </div>
    </div>
    <div class="inbox-message__right">
      <time class="inbox-message__time" :title="fullTime">{{ timeLabel }}</time>
      <div class="inbox-message__actions">
        <button type="button" class="mail-icon-button" :class="{ 'is-starred': email.is_starred }" :disabled="busy" :aria-label="t(email.is_starred ? 'removeStar' : 'addStar')" :title="t(email.is_starred ? 'removeStar' : 'addStar')" :aria-pressed="Boolean(email.is_starred)" @click.stop="emit('star', email)"><MailIcon name="star" :size="17" /></button>
        <button type="button" class="mail-icon-button" :disabled="busy" :aria-label="t(email.is_read ? 'markUnread' : 'markRead')" :title="t(email.is_read ? 'markUnread' : 'markRead')" @click.stop="emit('read', email)"><MailIcon :name="email.is_read ? 'mail' : 'check-circle'" :size="15" /></button>
      </div>
    </div>
  </article>
</template>

<style scoped>
.inbox-message__open { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: inherit; color: inherit; text-align: left; background: none; border: 0; padding: 0; }
</style>
