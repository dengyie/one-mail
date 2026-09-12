import { createApp } from 'vue'
import { createHead } from '@unhead/vue/client'

// Tailwind（awesome-ui 组件依赖）——在 Naive UI 组件样式前引入，避免覆盖冲突
import './tailwind.css'

import App from './App.vue'
import router from './router'
import i18n from './i18n'
import { api } from './api'
import { useGlobalState } from './store'
import { installUnifiedCursorPagination } from './utils/unified-cursor-pagination'
import { installUnifiedProviderMutations } from './utils/unified-provider-mutations'

const { userJwt, unifiedApiKey } = useGlobalState()
const unifiedAuth = () => ({
  userJwt: userJwt.value,
  apiKey: unifiedApiKey.value,
})

installUnifiedCursorPagination(api, () => {
  const jwt = userJwt.value?.trim()
  if (jwt) return `user:${jwt}`
  const key = unifiedApiKey.value?.trim()
  return key ? `key:${key}` : ''
})
// Existing detail actions await these API methods. External provider writes now
// resolve only after the durable mutation job reaches a terminal success, so the
// UI cannot report a queued IMAP/Graph write as already completed.
installUnifiedProviderMutations(api, unifiedAuth)

const head = createHead()
const app = createApp(App)
app.use(i18n)
app.use(router)
app.use(head)
app.mount('#app')
