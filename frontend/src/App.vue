<script setup>
import {
  darkTheme,
} from 'naive-ui'
import { ref, computed, onMounted, watchEffect } from 'vue'
import { useScript } from '@unhead/vue'
import { useI18n } from 'vue-i18n'
import { useGlobalState } from './store'
import { useIsMobile } from './utils/composables'
import AppSidebar from './components/layout/AppSidebar.vue'
import AppNavbar from './components/layout/AppNavbar.vue'
import Footer from './views/Footer.vue';
import { api } from './api'
import { getNaiveLocaleConfig } from './i18n/naive-locale'
import { DEFAULT_LOCALE, isSupportedLocale } from './i18n/utils'

const {
  isDark, loading, useSideMargin, telegramApp, isTelegram
} = useGlobalState()
const adClient = import.meta.env.VITE_GOOGLE_AD_CLIENT;
const adSlot = import.meta.env.VITE_GOOGLE_AD_SLOT;
const { locale } = useI18n({ useScope: 'global' });
const theme = computed(() => isDark.value ? darkTheme : null)
const localeConfig = computed(() => getNaiveLocaleConfig(isSupportedLocale(locale.value) ? locale.value : DEFAULT_LOCALE))
const isMobile = useIsMobile()

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
  <n-config-provider :locale="localeConfig.locale" :date-locale="localeConfig.dateLocale" :theme="theme">
    <n-global-style />
    <n-dialog-provider>
      <n-notification-provider container-style="margin-top: 60px;">
        <n-message-provider container-style="margin-top: 20px;">
          <!-- Modern Workspace Shell with Sleek Sidebar & Dynamic Navbar -->
          <div class="flex h-screen w-screen overflow-hidden bg-slate-100/70 dark:bg-slate-950 text-slate-800 dark:text-slate-100 antialiased font-sans transition-colors">
            
            <!-- Desktop Collapsible Sidebar -->
            <div class="hidden md:block shrink-0 h-full">
              <AppSidebar
                :collapsed="sidebarCollapsed"
                @update:collapsed="sidebarCollapsed = $event"
              />
            </div>

            <!-- Mobile Drawer Sidebar -->
            <n-drawer v-model:show="showMobileDrawer" placement="left" :width="280">
              <AppSidebar
                :collapsed="false"
                @navigate="showMobileDrawer = false"
              />
            </n-drawer>

            <!-- Main Content Viewport -->
            <div class="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
              <AppNavbar
                :sidebar-collapsed="sidebarCollapsed"
                @toggle-sidebar="toggleSidebar"
                @open-mobile-menu="showMobileDrawer = true"
              />

              <main class="flex-1 overflow-y-auto px-3 sm:px-8 py-6">
                <div class="max-w-6xl mx-auto w-full space-y-6">
                  <n-spin description="loading..." :show="loading">
                    <router-view></router-view>
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
  margin-left: 10px;
  margin-right: 10px;
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
