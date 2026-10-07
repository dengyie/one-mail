<script setup>
import { useScopedI18n } from '@/i18n/app'
import { useGlobalState } from '../store'
import DOMPurify from 'dompurify'
import UiIcon from '../components/ai/UiIcon.vue'
const { openSettings } = useGlobalState()
const { t } = useScopedI18n('workspace')
</script>

<template>
  <footer class="workspace-footer">
    <span class="workspace-footer__brand"><UiIcon name="layers" :size="12" /><span>One Mail</span><span>·</span><span>{{ t('brandTagline') }}</span></span>
    <div class="workspace-footer__copyright"><span>© {{ new Date().getFullYear() }}</span><span v-html="DOMPurify.sanitize(openSettings.copyright)"></span></div>
  </footer>
</template>
