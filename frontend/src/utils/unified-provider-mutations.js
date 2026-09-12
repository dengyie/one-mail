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

const buildQuery = (params = {}) => {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      if (value.length) qs.set(key, value.join(','))
    } else {
      qs.set(key, String(value))
    }
  }
  return qs.toString()
}

export const createMutationStatusFetcher = ({
  apiBase = import.meta.env.VITE_API_BASE || '',
  fetchImpl = globalThis.fetch,
} = {}) => async (jobId, auth) => {
  if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable')
  const response = await fetchImpl(
    `${String(apiBase).replace(/\/$/, '')}/api/unified/mutations/${encodeURIComponent(jobId)}`,
    { method: 'GET', headers: { Accept: 'application/json', ...(auth?.headers || {}) } },
  )
  return responseDetail(response)
}

export const createUnifiedMutationTransport = ({
  apiBase = import.meta.env.VITE_API_BASE || '',
  fetchImpl = globalThis.fetch,
} = {}) => async (path, { method = 'GET', body, auth } = {}) => {
  if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable')
  const headers = { Accept: 'application/json', ...(auth?.headers || {}) }
  const options = { method, headers }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    options.body = JSON.stringify(body)
  }
  const response = await fetchImpl(`${String(apiBase).replace(/\/$/, '')}${path}`, options)
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
  const transport = options.transport || createUnifiedMutationTransport(options)
  const finishQueued = async (result, initialAuth, resultMapper) => {
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
  const wrap = (base, resultMapper) => async (...args) => {
    const initialAuth = authSnapshot(getAuth?.())
    const result = await base(...args)
    return finishQueued(result, initialAuth, resultMapper)
  }
  const requireAuth = () => {
    const auth = authSnapshot(getAuth?.())
    if (!auth.key) throw new Error('unified auth unavailable')
    return auth
  }

  const baseMarkRead = api.unified.markRead.bind(api.unified)
  const baseToggleStar = api.unified.toggleStar.bind(api.unified)

  api.unified.markRead = wrap(baseMarkRead, (queued, terminal) => ({
    ...queued,
    ...terminal,
    // Status polling is authoritative. If a future queue implementation
    // coalesces multiple callers onto one durable intent, never let the older
    // enqueue response overwrite the terminal desired state.
    is_read: Number(terminal?.desired_value ?? queued?.desired_value ?? 1) ? 1 : 0,
  }))
  api.unified.toggleStar = wrap(baseToggleStar, (queued, terminal) => ({
    ...queued,
    ...terminal,
    is_starred: Number(terminal?.desired_value ?? queued?.desired_value ?? 0) ? 1 : 0,
  }))

  // Keep provider mutation transport next to the existing terminal-polling
  // wrapper instead of duplicating raw fetch/auth logic in the large api module.
  // If the api module grows native implementations later, preserve and wrap them.
  const baseMoveEmail = typeof api.unified.moveEmail === 'function'
    ? api.unified.moveEmail.bind(api.unified)
    : null
  const baseDeleteEmail = typeof api.unified.deleteEmail === 'function'
    ? api.unified.deleteEmail.bind(api.unified)
    : null
  const baseListFolders = typeof api.unified.listFolders === 'function'
    ? api.unified.listFolders.bind(api.unified)
    : null

  api.unified.listFolders = async (params = {}) => {
    if (baseListFolders) return baseListFolders(params)
    const auth = requireAuth()
    const query = buildQuery(params)
    return transport(`/api/unified/folders${query ? `?${query}` : ''}`, { auth })
  }

  api.unified.moveEmail = async (id, folderId) => {
    const initialAuth = requireAuth()
    const result = baseMoveEmail
      ? await baseMoveEmail(id, folderId)
      : await transport(`/api/unified/emails/${encodeURIComponent(id)}/move`, {
          method: 'POST',
          body: { folder_id: folderId },
          auth: initialAuth,
        })
    return finishQueued(result, initialAuth, (queued, terminal) => ({
      ...queued,
      ...terminal,
      source_folder: terminal?.target_folder ?? queued?.target_folder ?? null,
      source_folder_id: terminal?.target_folder_id ?? queued?.target_folder_id ?? null,
    }))
  }

  api.unified.deleteEmail = async (id) => {
    const initialAuth = requireAuth()
    const result = baseDeleteEmail
      ? await baseDeleteEmail(id)
      : await transport(`/api/unified/emails/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          auth: initialAuth,
        })
    return finishQueued(result, initialAuth, (queued, terminal) => ({
      ...queued,
      ...terminal,
      deleted: terminal?.status === 'succeeded' || queued?.deleted === true,
    }))
  }

  Object.defineProperty(api.unified, '__providerMutationInstalled', { value: true })
}