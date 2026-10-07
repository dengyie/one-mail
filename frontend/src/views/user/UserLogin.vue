<script setup>
import { computed, ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import { useScopedI18n } from '@/i18n/app'
import MailIcon from '../../components/ui/MailIcon.vue'
import { startAuthentication } from '@simplewebauthn/browser'

import { useGlobalState } from '../../store'
import { api } from '../../api'
import { getRouterPathWithLang } from '../../utils'
import Turnstile from '../../components/Turnstile.vue'

const router = useRouter()
const message = useMessage()
const { t, locale } = useScopedI18n('views.user.UserLogin')
const { t: w } = useScopedI18n('workspace')

const {
  userJwt, userOpenSettings, openSettings,
  userOauth2SessionState, userOauth2SessionClientID
} = useGlobalState()

const mode = ref('login') // 'login' | 'register' | 'passkey'
const showPassword = ref(false)
const submitting = ref(false)
const authenticatingPasskey = ref(false)

const form = ref({
  email: '',
  password: '',
  code: ''
})

const signupCfToken = ref('')
const loginCfToken = ref('')
const loginTurnstileRef = ref(null)
const signupTurnstileRef = ref(null)

const verifyCodeExpire = ref(0)
const verifyCodeTimeout = ref(0)

const getVerifyCodeTimeout = () => {
  if (!verifyCodeExpire.value || verifyCodeExpire.value < Date.now()) return 0
  return Math.round((verifyCodeExpire.value - Date.now()) / 1000)
}

const sendVerificationCode = async () => {
  if (!form.value.email) {
    message.error(t('pleaseInputEmail'))
    return
  }
  const currentCfToken = signupCfToken.value
  if (openSettings.value.cfTurnstileSiteKey && !currentCfToken && userOpenSettings.value.enableMailVerify) {
    message.error(t('turnstileCheckFailed'))
    return
  }
  try {
    const res = await api.fetch('/user_api/verify_code', {
      method: 'POST',
      body: JSON.stringify({
        email: form.value.email,
        cf_token: currentCfToken
      })
    })
    if (res && res.expirationTtl) {
      message.success(t('verifyCodeSent', { timeout: res.expirationTtl }))
      verifyCodeExpire.value = Date.now() + res.expirationTtl * 1000
      const intervalId = setInterval(() => {
        verifyCodeTimeout.value = getVerifyCodeTimeout()
        if (verifyCodeTimeout.value <= 0) {
          clearInterval(intervalId)
          verifyCodeTimeout.value = 0
        }
      }, 1000)
    }
  } catch (error) {
    message.error(error.message || 'send verification code failed')
  }
  signupTurnstileRef.value?.refresh?.()
}

const handleLogin = async () => {
  if (!form.value.email || !form.value.password) {
    message.error(t('pleaseInput'))
    return
  }
  submitting.value = true
  try {
    const res = await api.fetch('/user_api/login', {
      method: 'POST',
      body: JSON.stringify({
        email: form.value.email,
        password: form.value.password,
        cf_token: loginCfToken.value
      })
    })
    userJwt.value = res.jwt
    await api.getUserSettings(message)
    message.success('登录成功，正在进入工作台...')
    await router.push(getRouterPathWithLang('/unified', locale.value))
  } catch (error) {
    message.error(error.message || '登录失败，请检查账号密码')
    loginTurnstileRef.value?.refresh?.()
  } finally {
    submitting.value = false
  }
}

const handleRegister = async () => {
  if (!form.value.email || !form.value.password) {
    message.error(t('pleaseInput'))
    return
  }
  if (!form.value.code && userOpenSettings.value.enableMailVerify) {
    message.error(t('pleaseInputCode'))
    return
  }
  submitting.value = true
  try {
    const res = await api.fetch('/user_api/register', {
      method: 'POST',
      body: JSON.stringify({
        email: form.value.email,
        password: form.value.password,
        code: form.value.code,
        cf_token: signupCfToken.value
      })
    })
    if (res) {
      mode.value = 'login'
      message.success('注册成功，请使用新账号登录')
    }
  } catch (error) {
    message.error(error.message || '注册失败')
  } finally {
    submitting.value = false
  }
}

const passkeyLogin = async () => {
  if (authenticatingPasskey.value) return
  authenticatingPasskey.value = true
  try {
    const opts = await api.fetch('/user_api/passkey/authenticate_request', {
      method: 'POST',
      body: JSON.stringify({
        domain: location.hostname,
        email: form.value.email.trim() || undefined,
      })
    })
    const authResp = await startAuthentication({ optionsJSON: opts })
    const res = await api.fetch('/user_api/passkey/authenticate_response', {
      method: 'POST',
      body: JSON.stringify({
        credential: authResp,
      })
    })
    userJwt.value = res.jwt
    await api.getUserSettings(message)
    message.success('通行密钥认证成功！')
    await router.push(getRouterPathWithLang('/unified', locale.value))
  } catch (error) {
    message.error(error.message || 'Passkey 登录失败')
  } finally {
    authenticatingPasskey.value = false
  }
}

const oauth2Login = async (clientID) => {
  try {
    const res = await api.fetch(`/user_api/oauth2/login_url?clientID=${clientID}`)
    userOauth2SessionState.value = res.state
    userOauth2SessionClientID.value = clientID
    location.href = res.url
  } catch (error) {
    message.error(error.message || '获取 OAuth2 登录链接失败')
  }
}

onMounted(async () => {
  await api.getUserOpenSettings(message)
  await api.getOpenSettings(message)
})
</script>

<template>
  <div class="mail-auth">
    <section class="mail-auth__story">
      <div class="workspace-eyebrow">ONE MAIL / {{ w('privateSpace') }}</div>
      <h1>{{ w('loginHero') }}</h1>
      <p class="mail-auth__intro">{{ w('loginDescription') }}</p>
      <div class="mail-auth__features">
        <div v-for="feature in [{ icon: 'layers', title: 'featureUnified', text: 'featureUnifiedText' }, { icon: 'key', title: 'featureCodes', text: 'featureCodesText' }, { icon: 'address', title: 'featurePrivate', text: 'featurePrivateText' }]" :key="feature.title" class="mail-auth__feature"><span><MailIcon :name="feature.icon" :size="20" /></span><div><h2>{{ w(feature.title) }}</h2><p>{{ w(feature.text) }}</p></div></div>
      </div>
      <div class="mail-auth__privacy"><MailIcon name="shield" :size="15" />{{ w('privacyHint') }}</div>
    </section>
    <section class="mail-auth__card">
      <div class="mail-auth__heading"><div class="mail-auth__badge"><MailIcon name="inbox" :size="23" /></div><h2>{{ w(mode === 'login' ? 'welcome' : 'registerTitle') }}</h2><p>{{ w(mode === 'login' ? 'welcomeSubtitle' : 'registerSubtitle') }}</p></div>
      <div v-if="userOpenSettings.enable" class="mail-auth__tabs" role="group" :aria-label="w('account')"><button type="button" :aria-pressed="mode === 'login'" @click="mode = 'login'">{{ w('loginTab') }}</button><button type="button" :aria-pressed="mode === 'register'" @click="mode = 'register'">{{ w('registerTab') }}</button></div>
      <form class="mail-auth__form" @submit.prevent="mode === 'login' ? handleLogin() : handleRegister()">
        <div class="mail-field"><label for="auth-email">{{ w('emailLabel') }}</label><input id="auth-email" v-model="form.email" type="email" required autocomplete="email" placeholder="name@example.com" /></div>
        <div class="mail-field"><label for="auth-password">{{ w('passwordLabel') }}</label><div class="mail-field__password"><input id="auth-password" v-model="form.password" :type="showPassword ? 'text' : 'password'" required :autocomplete="mode === 'login' ? 'current-password' : 'new-password'" placeholder="••••••••" /><button type="button" class="mail-icon-button" :aria-label="w(showPassword ? 'hidePassword' : 'showPassword')" :aria-pressed="showPassword" @click="showPassword = !showPassword"><MailIcon :name="showPassword ? 'lock' : 'eye'" :size="17" /></button></div></div>
        <div v-if="mode === 'register' && userOpenSettings.enableMailVerify" class="mail-field"><label for="auth-code">{{ w('codeLabel') }}</label><div class="flex gap-2"><input id="auth-code" v-model="form.code" type="text" required autocomplete="one-time-code" inputmode="numeric" /><n-button :disabled="verifyCodeTimeout > 0" @click="sendVerificationCode">{{ verifyCodeTimeout > 0 ? `${verifyCodeTimeout}s` : w('sendCode') }}</n-button></div></div>
        <div v-if="openSettings.enableGlobalTurnstileCheck"><Turnstile v-if="mode === 'login'" ref="loginTurnstileRef" v-model:value="loginCfToken" /><Turnstile v-else ref="signupTurnstileRef" v-model:value="signupCfToken" /></div>
        <n-button attr-type="submit" type="primary" block size="large" :loading="submitting">{{ w(mode === 'login' ? 'login' : 'register') }}<template #icon><MailIcon name="arrow-right" :size="17" /></template></n-button>
      </form>
      <div class="mail-auth__separator"><span>{{ w('alternativeLogin') }}</span></div>
      <n-button block :loading="authenticatingPasskey" @click="passkeyLogin"><template #icon><MailIcon name="key" :size="17" /></template>{{ t('loginWithPasskey') }}</n-button>
      <div v-if="userOpenSettings.oauth2ClientIDs?.length" class="space-y-2 mt-3"><n-button v-for="provider in userOpenSettings.oauth2ClientIDs" :key="provider.clientID" block @click="oauth2Login(provider.clientID)">{{ w('loginProvider', { name: provider.name }) }}</n-button></div>
    </section>
  </div>
</template>
