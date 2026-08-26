<script setup>
import { computed, ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import { useScopedI18n } from '@/i18n/app'
import {
  LockFilled, ShieldFilled, MarkEmailReadFilled,
  AutoAwesomeFilled, VpnKeyFilled, PersonFilled,
  ArrowForwardFilled, EmailFilled, VisibilityFilled,
  VisibilityOffFilled, RefreshFilled
} from '@vicons/material'
import { KeyFilled } from '@vicons/material'
import { startAuthentication } from '@simplewebauthn/browser'

import { useGlobalState } from '../../store'
import { api } from '../../api'
import { hashPassword, getRouterPathWithLang } from '../../utils'
import StatusIndicator from '../../components/ai/StatusIndicator.vue'
import Turnstile from '../../components/Turnstile.vue'

const router = useRouter()
const message = useMessage()
const { t, locale } = useScopedI18n('views.user.UserLogin')

const {
  userJwt, userOpenSettings, openSettings,
  userOauth2SessionState, userOauth2SessionClientID
} = useGlobalState()

const mode = ref('login') // 'login' | 'register' | 'passkey'
const showPassword = ref(false)
const submitting = ref(false)

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
        password: await hashPassword(form.value.password),
        cf_token: loginCfToken.value
      })
    })
    userJwt.value = res.jwt
    await api.getUserSettings(message)
    message.success('登录成功，正在进入工作台...')
    await router.push(getRouterPathWithLang('/', locale.value))
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
        password: await hashPassword(form.value.password),
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
  try {
    const opts = await api.fetch('/user_api/passkey/authenticate_request', {
      method: 'POST',
      body: JSON.stringify({ email: form.value.email })
    })
    const authResp = await startAuthentication({ optionsJSON: opts })
    const res = await api.fetch('/user_api/passkey/authenticate_response', {
      method: 'POST',
      body: JSON.stringify(authResp)
    })
    userJwt.value = res.jwt
    await api.getUserSettings(message)
    message.success('通行密钥认证成功！')
    await router.push(getRouterPathWithLang('/', locale.value))
  } catch (error) {
    message.error(error.message || 'Passkey 登录失败')
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
  <div class="min-h-[calc(100vh-140px)] flex flex-col justify-center py-4">
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-center max-w-6xl mx-auto w-full">
      
      <!-- Left Column: Hero & Core Product Features (仿照 tfm 架构展示) -->
      <div class="lg:col-span-7 space-y-8 text-left">
        <div class="space-y-4">
          <!-- Status Pill -->
          <div class="inline-flex items-center gap-2.5 px-3.5 py-1.5 rounded-full bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 text-xs font-semibold tracking-wide border border-blue-200/60 dark:border-blue-800/60 shadow-xs">
            <StatusIndicator status="online" size="sm" />
            <span>智能隐私收件工作台</span>
          </div>

          <h1 class="text-3xl sm:text-5xl font-black text-slate-900 dark:text-white tracking-tight leading-tight">
            随取随用的 <span class="bg-gradient-to-r from-blue-600 via-indigo-600 to-cyan-500 bg-clip-text text-transparent">智能收件箱</span>
          </h1>

          <p class="text-base sm:text-lg text-slate-600 dark:text-slate-300 leading-relaxed max-w-xl">
            来信毫秒级自动送达，AI 智能提取验证码与关键操作。登录后解锁永久多源归集与统一工作台。
          </p>
        </div>

        <!-- 3 Feature Highlight Cards (类似 tfm.memom.mom) -->
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
          <!-- Feature 1 -->
          <div class="p-4 rounded-2xl bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border border-slate-200/80 dark:border-slate-800/80 shadow-xs space-y-2 hover:border-blue-500/40 transition-all">
            <div class="w-9 h-9 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 flex items-center justify-center">
              <n-icon size="20" :component="ShieldFilled" />
            </div>
            <h2 class="font-bold text-sm text-slate-900 dark:text-white">地址永久保留</h2>
            <p class="text-xs text-slate-500 dark:text-slate-400 leading-normal">
              专属绑定的地址永不回收，不被他人抢注，随时登录找回。
            </p>
          </div>

          <!-- Feature 2 -->
          <div class="p-4 rounded-2xl bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border border-slate-200/80 dark:border-slate-800/80 shadow-xs space-y-2 hover:border-indigo-500/40 transition-all">
            <div class="w-9 h-9 rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 flex items-center justify-center">
              <n-icon size="20" :component="MarkEmailReadFilled" />
            </div>
            <h2 class="font-bold text-sm text-slate-900 dark:text-white">验证码一键复制</h2>
            <p class="text-xs text-slate-500 dark:text-slate-400 leading-normal">
              邮件到达后自动识别 OTP 与链接，大字置顶展示一键提取。
            </p>
          </div>

          <!-- Feature 3 -->
          <div class="p-4 rounded-2xl bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border border-slate-200/80 dark:border-slate-800/80 shadow-xs space-y-2 hover:border-cyan-500/40 transition-all">
            <div class="w-9 h-9 rounded-xl bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 flex items-center justify-center">
              <n-icon size="20" :component="AutoAwesomeFilled" />
            </div>
            <h2 class="font-bold text-sm text-slate-900 dark:text-white">私人专属邮箱</h2>
            <p class="text-xs text-slate-500 dark:text-slate-400 leading-normal">
              登录后自选前缀创建私人信箱，仅你可见，支持多端归集。
            </p>
          </div>
        </div>

        <!-- Hint -->
        <div class="flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500 pt-1">
          <n-icon size="16" :component="LockFilled" />
          <span>全链路端到端加密与 Cloudflare 安全防护 · 登录后进入专属邮箱侧边栏</span>
        </div>
      </div>

      <!-- Right Column: Login / Register Authentication Card -->
      <div class="lg:col-span-5 w-full">
        <div class="bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl rounded-3xl border border-slate-200/90 dark:border-slate-800/90 shadow-2xl shadow-blue-500/5 p-6 sm:p-8">
          
          <!-- Card Header & Tabs -->
          <div class="flex items-center justify-between pb-6 border-b border-slate-100 dark:border-slate-800/80">
            <div>
              <h2 class="text-xl font-bold text-slate-900 dark:text-white tracking-tight">
                {{ mode === 'login' ? '账号登录' : '快速注册' }}
              </h2>
              <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                {{ mode === 'login' ? '登录以进入专属收件控制台' : '注册账号以永久保留您的私人信箱' }}
              </p>
            </div>

            <!-- Mode Switch Pills -->
            <div v-if="userOpenSettings.enable" class="flex p-1 bg-slate-100 dark:bg-slate-800/80 rounded-xl">
              <button
                @click="mode = 'login'"
                class="px-3 py-1 text-xs font-semibold rounded-lg transition-all"
                :class="mode === 'login' ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-400 shadow-xs' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'"
              >
                登录
              </button>
              <button
                @click="mode = 'register'"
                class="px-3 py-1 text-xs font-semibold rounded-lg transition-all"
                :class="mode === 'register' ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-400 shadow-xs' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'"
              >
                注册
              </button>
            </div>
          </div>

          <!-- Form Area -->
          <form @submit.prevent="mode === 'login' ? handleLogin() : handleRegister()" class="mt-6 space-y-4">
            <!-- Email Input -->
            <div class="space-y-1.5">
              <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                电子邮箱账号
              </label>
              <div class="relative">
                <input
                  v-model="form.email"
                  type="email"
                  required
                  placeholder="name@example.com"
                  class="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/80 rounded-xl text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 transition-all"
                />
              </div>
            </div>

            <!-- Password Input -->
            <div class="space-y-1.5">
              <div class="flex items-center justify-between">
                <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                  登录密码
                </label>
              </div>
              <div class="relative">
                <input
                  v-model="form.password"
                  :type="showPassword ? 'text' : 'password'"
                  required
                  placeholder="••••••••"
                  class="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/80 rounded-xl text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 transition-all pr-10"
                />
                <button
                  type="button"
                  @click="showPassword = !showPassword"
                  class="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                >
                  <n-icon size="18" :component="showPassword ? VisibilityOffFilled : VisibilityFilled" />
                </button>
              </div>
            </div>

            <!-- Verification Code (Only for Register when mail verify enabled) -->
            <div v-if="mode === 'register' && userOpenSettings.enableMailVerify" class="space-y-1.5">
              <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                邮箱验证码
              </label>
              <div class="flex gap-2">
                <input
                  v-model="form.code"
                  type="text"
                  placeholder="6位验证码"
                  class="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/80 rounded-xl text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 transition-all"
                />
                <button
                  type="button"
                  :disabled="verifyCodeTimeout > 0"
                  @click="sendVerificationCode"
                  class="px-4 py-2.5 text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-xl whitespace-nowrap transition-all disabled:opacity-50"
                >
                  {{ verifyCodeTimeout > 0 ? `${verifyCodeTimeout}s` : '获取验证码' }}
                </button>
              </div>
            </div>

            <!-- Turnstile Protection -->
            <div v-if="openSettings.enableGlobalTurnstileCheck" class="py-1">
              <Turnstile
                ref="loginTurnstileRef"
                v-if="mode === 'login'"
                v-model:value="loginCfToken"
              />
              <Turnstile
                ref="signupTurnstileRef"
                v-else
                v-model:value="signupCfToken"
              />
            </div>

            <!-- Submit Button -->
            <button
              type="submit"
              :disabled="submitting"
              class="w-full mt-2 py-3 px-4 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white text-sm font-bold rounded-xl shadow-lg shadow-blue-500/20 hover:shadow-blue-500/30 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-70"
            >
              <n-icon v-if="submitting" size="18" class="animate-spin" :component="RefreshFilled" />
              <span>{{ mode === 'login' ? '立即登录' : '立即注册' }}</span>
              <n-icon v-if="!submitting" size="18" :component="ArrowForwardFilled" />
            </button>
          </form>

          <!-- Alternative Auth Methods: Passkey & OAuth2 -->
          <div class="mt-6 pt-5 border-t border-slate-100 dark:border-slate-800/80 space-y-3">
            <button
              type="button"
              @click="passkeyLogin"
              class="w-full py-2.5 px-4 bg-slate-50 hover:bg-slate-100 dark:bg-slate-800/60 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-semibold rounded-xl border border-slate-200 dark:border-slate-700/80 transition-all flex items-center justify-center gap-2"
            >
              <n-icon size="16" :component="KeyFilled" />
              <span>使用 Passkey 通行密钥登录</span>
            </button>

            <!-- OAuth2 Providers (e.g., LinuxDo, GitHub, etc.) -->
            <div v-if="userOpenSettings.oauth2ClientIDs && userOpenSettings.oauth2ClientIDs.length > 0" class="grid grid-cols-1 gap-2 pt-1">
              <button
                v-for="provider in userOpenSettings.oauth2ClientIDs"
                :key="provider.clientID"
                type="button"
                @click="oauth2Login(provider.clientID)"
                class="w-full py-2.5 px-4 bg-slate-50 hover:bg-slate-100 dark:bg-slate-800/60 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-semibold rounded-xl border border-slate-200 dark:border-slate-700/80 transition-all flex items-center justify-center gap-2"
              >
                <span>使用 {{ provider.name }} 快捷登录</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
