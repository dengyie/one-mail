const MAX_CURSOR_SCOPES = 16
const INSTALL_FLAG = Symbol.for('one-mail.unified-cursor-pagination')

const stableSignature = (params) => JSON.stringify(
  Object.entries(params)
    .filter(([key, value]) => key !== 'offset' && key !== 'cursor' && value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]),
)

const validPageShape = (params) => {
  const limit = Number(params?.limit)
  const offset = Number(params?.offset ?? 0)
  return Number.isSafeInteger(limit) && limit > 0
    && Number.isSafeInteger(offset) && offset >= 0
    && offset % limit === 0
    ? { limit, offset }
    : null
}

/**
 * Wrap the existing offset-based listEmails caller without changing page UI.
 *
 * - page 1 (`offset=0`) is translated to the backend's cursor-default request;
 * - a sequential page whose boundary was observed uses `next_cursor`;
 * - an arbitrary page jump without a known boundary stays on explicit OFFSET;
 * - auth-scope changes clear every cached cursor before the next request.
 *
 * Cursors remain opaque: the browser never parses or manufactures them.
 */
export const createCursorAwareListEmails = (baseListEmails, getScopeKey = () => '') => {
  if (typeof baseListEmails !== 'function') throw new TypeError('baseListEmails must be a function')

  const cursorsBySignature = new Map()
  let activeScope = undefined

  const resetForScope = () => {
    const scope = String(getScopeKey?.() ?? '')
    if (scope !== activeScope) {
      cursorsBySignature.clear()
      activeScope = scope
    }
  }

  const touchSignature = (signature, state) => {
    cursorsBySignature.delete(signature)
    cursorsBySignature.set(signature, state)
    while (cursorsBySignature.size > MAX_CURSOR_SCOPES) {
      cursorsBySignature.delete(cursorsBySignature.keys().next().value)
    }
  }

  return async (params = {}) => {
    resetForScope()

    // Callers that intentionally supply a cursor own the contract themselves.
    if (params?.cursor !== undefined && params?.cursor !== null && params?.cursor !== '') {
      return baseListEmails(params)
    }

    const page = validPageShape(params)
    if (!page) return baseListEmails(params)

    const signature = stableSignature(params)
    let state = cursorsBySignature.get(signature)
    const requestParams = { ...params }
    let usedCursor = false

    if (page.offset === 0) {
      // A first-page refresh defines a new snapshot boundary. Drop stale page
      // cursors for this filter set and seed them again from the response.
      state = new Map()
      touchSignature(signature, state)
      delete requestParams.offset
      usedCursor = true
    } else {
      const cursor = state?.get(page.offset)
      if (cursor) {
        delete requestParams.offset
        requestParams.cursor = cursor
        usedCursor = true
        touchSignature(signature, state)
      }
    }

    const result = await baseListEmails(requestParams)

    if (usedCursor && state) {
      const nextOffset = page.offset + page.limit
      if (result?.has_more === true && typeof result?.next_cursor === 'string' && result.next_cursor) {
        state.set(nextOffset, result.next_cursor)
      } else {
        // The current boundary no longer has a following cursor. Remove this
        // and any deeper cached pages so a future page jump falls back safely.
        for (const offset of [...state.keys()]) {
          if (offset >= nextOffset) state.delete(offset)
        }
      }
      touchSignature(signature, state)
    }

    return result
  }
}

export const installUnifiedCursorPagination = (api, getScopeKey = () => '') => {
  if (!api?.unified || typeof api.unified.listEmails !== 'function') {
    throw new TypeError('unified listEmails API is required')
  }
  if (api.unified[INSTALL_FLAG]) return

  api.unified.listEmails = createCursorAwareListEmails(api.unified.listEmails, getScopeKey)
  Object.defineProperty(api.unified, INSTALL_FLAG, { value: true })
}
