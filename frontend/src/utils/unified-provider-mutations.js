import { safeBearerHeader, safeHeaderValue } from './headers'

const DEFAULT_POLL_MS = 1200
const DEFAULT_TIMEOUT_MS = 45_000

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const authSnapshot = ({ userJwt, apiKey } = {}) => {
  const user = safeHeaderValue(userJwt)
  if (user) return { key: `user:${user}`, headers: { 'x-user-token': user } }
  const bearer = safeBearerHeader(apiKey)
  if (bearer) return { key: `key:${bearer.slice(7)}`, headers: { Authorization: bearer } }
  return { key: '', headers: {} }
}

const responseDetail = async (response) => {
  let body = null
  try { body = await response.json() } catch { /* response can be empty */ }
  if (response.ok) return body || {}
  const detail = body && typeof body === 'object'
    ? body.error || body.message || JSON.stringify(body)
    : `HTTP ${response.status}`
  const error = new Error(`Code ${response.status}: ${detail || 'error'}`)
  error.status = response.status
  throw error
}

export const createMutationStatusFetcher = ({
  apiBase = import.meta.env.VITE_API_BASE || '',
  fetchImpl = globalThis.fetch,
} = {}) => async (jobId, auth) => {
  if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable')
  const response = await fetchImpl(
    `${apiBase}/api/unified/mutations/${encodeURIComponent(jobId)}`,
    { method: 'GET', headers: { Accept: 'application/json', ...(auth?.headers || {}) } },
  )
  return responseDetail(response)
}

export const waitForMutationTerminal = async (jobId, {
  initialAuth,
  getAuth,
  fetchStatus,
  pollMs = DEFAULT_POLL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sleepImpl = sleep,
} = {}) => {
  if (!jobId) throw new Error('provider mutation returned no job id')
  const started = Date.now()
  const firstAuth = initialAuth || authSnapshot(getAuth?.())
  if (!firstAuth.key) throw new Error('unified auth unavailable')

  while (Date.now() - started <= timeoutMs) {
    const currentAuth = authSnapshot(getAuth?.())
    if (!currentAuth.key || currentAuth.key !== firstAuth.key) {
      const error = new Error('登录身份已变化，源邮箱同步仍可能在后台继续')
      error.code = 'mutation_auth_changed'
      throw error
    }

    const status = await fetchStatus(jobId, firstAuth)
    if (status?.status === 'succeeded') return status
    if (['failed', 'unsupported', 'superseded'].includes(status?.status)) {
      const error = new Error(status?.error || `源邮箱同步失败：${status?.status}`)
      error.code = `mutation_${status.status}`
      error.mutation = status
      throw error
    }
    if (!['pending', 'processing'].includes(status?.status)) {
      const error = new Error(`未知的源邮箱同步状态：${status?.status || 'empty'}`)
      error.code = 'mutation_invalid_status'
      throw error
    }
    await sleepImpl(pollMs)
  }

  const error = new Error('操作已排队，源邮箱仍在后台同步；请稍后刷新确认')
  error.code = 'mutation_pending'
  throw error
}

export const installUnifiedProviderMutations = (api, getAuth, options = {}) => {
  if (!api?.unified || typeof api.unified.markRead !== 'function' || typeof api.unified.toggleStar !== 'function') {
    throw new TypeError('unified mutation APIs are required')
  }
  if (api.unified.__providerMutationInstalled) return

  const fetchStatus = options.fetchStatus || createMutationStatusFetcher(options)
  const wrap = (base, resultMapper) => async (...args) => {
    const initialAuth = authSnapshot(getAuth?.())
    const result = await base(...args)
    if (result?.status !== 'queued') return resultMapper(result, result)

    const terminal = await waitForMutationTerminal(result.job_id, {
      initialAuth,
      getAuth,
      fetchStatus,
      pollMs: options.pollMs,
      timeoutMs: options.timeoutMs,
      sleepImpl: options.sleepImpl,
    })
    return resultMapper(result, terminal)
  }

  const baseMarkRead = api.unified.markRead.bind(api.unified)
  const baseToggleStar = api.unified.toggleStar.bind(api.unified)

  api.unified.markRead = wrap(baseMarkRead, (queued, terminal) => ({
    ...queued,
    ...terminal,
    is_read: Number(queued?.desired_value ?? terminal?.desired_value ?? 1) ? 1 : 0,
  }))
  api.unified.toggleStar = wrap(baseToggleStar, (queued, terminal) => ({
    ...queued,
    ...terminal,
    is_starred: Number(queued?.desired_value ?? terminal?.desired_value ?? 0) ? 1 : 0,
  }))

  Object.defineProperty(api.unified, '__providerMutationInstalled', { value: true })
}
