<script setup>
import {
  darkTheme,
} from 'naive-ui'
import { ref, computed, onMounted, watchEffect } from 'vue'
import { useScript } from '@unhead/vue'
import { useI18n } from 'vue-i18n'
import { useGlobalState } from './store'
import { workspaceTheme } from './theme'
import { useScopedI18n } from './i18n/app'
import AppSidebar from './components/layout/AppSidebar.vue'
import AppNavbar from './components/layout/AppNavbar.vue'
import Footer from './views/Footer.vue';
import { api } from './api'
import { getNaiveLocaleConfig } from './i18n/naive-locale'
import { DEFAULT_LOCALE, isSupportedLocale } from './i18n/utils'

const {
  isDark, loading, useSideMargin, telegramApp, isTelegram, openSettings
} = useGlobalState()
const adClient = import.meta.env.VITE_GOOGLE_AD_CLIENT;
const adSlot = import.meta.env.VITE_GOOGLE_AD_SLOT;
const { locale } = useI18n({ useScope: 'global' });
const theme = computed(() => isDark.value ? darkTheme : null)
const localeConfig = computed(() => getNaiveLocaleConfig(isSupportedLocale(locale.value) ? locale.value : DEFAULT_LOCALE))
const themeOverrides = computed(() => workspaceTheme(isDark.value))
const { t: workspaceT } = useScopedI18n('workspace')

const sidebarCollapsed = ref(false)
const showMobileDrawer = ref(false)

const toggleSidebar = () => {
  sidebarCollapsed.value = !sidebarCollapsed.value
}

watchEffect(() => {
  if (typeof document === 'undefined') return
  document.documentElement.lang = isSupportedLocale(locale.value) ? locale.value : DEFAULT_LOCALE
})

// Load Google Ad script at top level (not inside onMounted)
if (adClient && adSlot) {
  useScript({
    src: `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${adClient}`,
    async: true,
    crossorigin: "anonymous",
  })
}

onMounted(async () => {
  try {
    await api.getUserSettings();
    if (!openSettings.value.fetched) await api.getOpenSettings();
  } catch (error) {
    console.error(error);
  }

  const token = import.meta.env.VITE_CF_WEB_ANALY_TOKEN;

  const exist = document.querySelector('script[src="https://static.cloudflareinsights.com/beacon.min.js"]') !== null
  if (token && !exist) {
    const script = document.createElement('script');
    script.defer = true;
    script.src = 'https://static.cloudflareinsights.com/beacon.min.js';
    script.dataset.cfBeacon = `{ token: ${token} }`;
    document.body.appendChild(script);
  }

  // check if google ad is enabled
  if (adClient && adSlot) {
    (window.adsbygoogle = window.adsbygoogle || []).push({});
    (window.adsbygoogle = window.adsbygoogle || []).push({});
  }

  // check if telegram is enabled
  const enableTelegram = import.meta.env.VITE_IS_TELEGRAM;
  if (
    (typeof enableTelegram === 'boolean' && enableTelegram === true)
    ||
    (typeof enableTelegram === 'string' && enableTelegram === 'true')
  ) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://telegram.org/js/telegram-web-app.js';
      script.onload = resolve;
      script.onerror = reject;
      document.body.appendChild(script);
    });
    telegramApp.value = window.Telegram?.WebApp || {};
    isTelegram.value = !!window.Telegram?.WebApp?.initData;
  }
});
</script>

<template>
  <n-config-provider :locale="localeConfig.locale" :date-locale="localeConfig.dateLocale" :theme="theme" :theme-overrides="themeOverrides">
    <n-global-style />
    <n-dialog-provider>
      <n-notification-provider container-style="margin-top: 60px;">
        <n-message-provider container-style="margin-top: 20px;">
          <a class="skip-link" href="#workspace-main">{{ workspaceT('skipToContent') }}</a>
          <div class="app-shell">
            <div class="app-sidebar-container">
              <AppSidebar :collapsed="sidebarCollapsed" @update:collapsed="sidebarCollapsed = $event" />
            </div>
            <n-drawer v-model:show="showMobileDrawer" placement="left" :width="280">
              <AppSidebar :collapsed="false" mobile @navigate="showMobileDrawer = false" @close="showMobileDrawer = false" />
            </n-drawer>
            <div class="app-main">
              <AppNavbar :sidebar-collapsed="sidebarCollapsed" @toggle-sidebar="toggleSidebar" @open-mobile-menu="showMobileDrawer = true" />
              <main id="workspace-main" class="workspace-main" tabindex="-1">
                <div class="workspace-content" :class="{ 'workspace-content--bounded': useSideMargin }">
                  <n-spin :show="loading">
                    <router-view />
                  </n-spin>
                  <Footer />
                </div>
              </main>
            </div>
          </div>
          <n-back-top />
        </n-message-provider>
      </n-notification-provider>
    </n-dialog-provider>
  </n-config-provider>
</template>

<style>
.n-switch {
  margin: 0;
}

@media (hover: none) and (pointer: coarse) and (max-width: 1024px) {
  :where(input, textarea, select, [contenteditable="true"]) {
    font-size: 16px !important;
  }

  :where(.n-input, .n-input-number, .n-base-selection, .n-input-group-label) {
    --n-font-size: 16px !important;
  }
}

::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: rgba(148, 163, 184, 0.25);
  border-radius: 9999px;
}
::-webkit-scrollbar-thumb:hover {
  background: rgba(148, 163, 184, 0.45);
}
</style>
