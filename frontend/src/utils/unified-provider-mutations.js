const DEFAULT_POLL_MS = 1200
const DEFAULT_TIMEOUT_MS = 45_000

const mutationError = (code, message, mutation) => Object.assign(new Error(message), { code, mutation })
const assertIdentity = (initial, getAuth) => {
  if (!initial.key || initial.key !== getAuth().key) {
    throw mutationError('mutation_auth_changed', '登录身份已变化，源邮箱同步仍可能在后台继续')
  }
}

// Settle promptly even if a transport ignores cancellation; consume late rejection.
const inScope = (action, signal) => new Promise((resolve, reject) => {
  const abort = () => reject(signal.reason)
  if (signal.aborted) { abort(); return }
  signal.addEventListener('abort', abort, { once: true })
  Promise.resolve().then(() => {
    signal.throwIfAborted()
    return action()
  }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
})

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(signal.reason) }
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
  if (signal.aborted) { abort(); return }
  signal.addEventListener('abort', abort, { once: true })
})

/**
 * @param {string} jobId
 * @param {import('../api/contracts').MutationPollOptions} options
 */
export const waitForMutationTerminal = async (jobId, {
  initialAuth, getAuth, fetchStatus, signal, pollMs = DEFAULT_POLL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS, sleepImpl = sleep,
}) => {
  if (!jobId) throw new Error('provider mutation returned no job id')
  const firstAuth = initialAuth || getAuth()
  const controller = new AbortController()
  const cancel = () => controller.abort(signal.reason)
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  const timer = setTimeout(() => controller.abort(mutationError(
    'mutation_pending', '操作已排队，源邮箱仍在后台同步；请稍后刷新确认',
  )), timeoutMs)
  try {
    while (true) {
      controller.signal.throwIfAborted()
      assertIdentity(firstAuth, getAuth)
      const status = await inScope(() => fetchStatus(jobId, firstAuth, { signal: controller.signal }), controller.signal)
      controller.signal.throwIfAborted()
      assertIdentity(firstAuth, getAuth)
      if (status?.status === 'succeeded') return status
      if (['failed', 'unsupported', 'superseded'].includes(status?.status)) {
        throw mutationError(`mutation_${status.status}`, status.error || `源邮箱同步失败：${status.status}`, status)
      }
      if (!['pending', 'processing'].includes(status?.status)) {
        throw mutationError('mutation_invalid_status', `未知的源邮箱同步状态：${status?.status || 'empty'}`, status)
      }
      await inScope(() => sleepImpl(pollMs, controller.signal), controller.signal)
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}

/**
 * Compose every provider write with the same authenticated HTTP client.
 * @param {import('../api/contracts').MutationApiDependencies} dependencies
 */
export const createUnifiedMutationApi = ({ request, getAuth, ...pollOptions }) => {
  const fetchStatus = (jobId, _auth, options) => request(`/api/unified/mutations/${encodeURIComponent(jobId)}`, options)
  const mutate = async (path, options, project) => {
    options.signal?.throwIfAborted()
    const initialAuth = getAuth()
    const result = await request(path, options)
    options.signal?.throwIfAborted()
    assertIdentity(initialAuth, getAuth)
    const terminal = result?.status === 'queued'
      ? await waitForMutationTerminal(result.job_id, { ...pollOptions, initialAuth, getAuth, fetchStatus, signal: options.signal })
      : result
    return project(terminal)
  }
  const emailPath = id => `/api/unified/emails/${encodeURIComponent(id)}`
  const setRead = (id, desired, options = {}) => mutate(`${emailPath(id)}/${desired ? 'read' : 'unread'}`, {
    ...options, method: 'POST',
  }, result => ({ ...result, is_read: Number(result?.desired_value ?? result?.is_read ?? desired) ? 1 : 0 }))
  return {
    markRead: (id, options) => setRead(id, 1, options),
    markUnread: (id, options) => setRead(id, 0, options),
    toggleStar: (id, desired, options = {}) => mutate(`${emailPath(id)}/star`, {
      ...options, method: 'POST', body: typeof desired === 'number' ? { is_starred: desired } : {},
    }, result => ({ ...result, is_starred: Number(result?.desired_value ?? result?.is_starred) ? 1 : 0 })),
    moveEmail: (id, folderId, options = {}) => mutate(`${emailPath(id)}/move`, {
      ...options, method: 'POST', body: { folder_id: folderId },
    }, result => ({ ...result, source_folder: result?.target_folder ?? null, source_folder_id: result?.target_folder_id ?? null })),
    deleteEmail: (id, options = {}) => mutate(emailPath(id), {
      ...options, method: 'DELETE',
    }, result => ({ ...result, deleted: result?.status === 'succeeded' || result?.deleted === true })),
  }
}
