import { describe, expect, it } from 'vitest'

import { createCursorAwareListEmails } from './unified-cursor-pagination'

describe('createCursorAwareListEmails', () => {
  it('translates page one and sequential pages to opaque cursors', async () => {
    const calls = []
    const base = async (params) => {
      calls.push(params)
      if (calls.length === 1) {
        return { results: [{ id: 'm3' }], count: 3, has_more: true, next_cursor: 'opaque-page-2' }
      }
      return { results: [{ id: 'm2' }], count: 0, has_more: false, next_cursor: null }
    }
    const list = createCursorAwareListEmails(base, () => 'user-a')

    await list({ account_id: 'acc', limit: 20, offset: 0 })
    await list({ account_id: 'acc', limit: 20, offset: 20 })

    expect(calls[0]).toEqual({ account_id: 'acc', limit: 20 })
    expect(calls[1]).toEqual({ account_id: 'acc', limit: 20, cursor: 'opaque-page-2' })
  })

  it('keeps arbitrary unknown page jumps on explicit offset', async () => {
    const calls = []
    const list = createCursorAwareListEmails(async (params) => {
      calls.push(params)
      return { results: [], count: 0 }
    })

    await list({ source: 'imap_qq', limit: 20, offset: 80 })
    expect(calls[0]).toEqual({ source: 'imap_qq', limit: 20, offset: 80 })
  })

  it('does not reuse a cursor across different filter signatures', async () => {
    const calls = []
    const list = createCursorAwareListEmails(async (params) => {
      calls.push(params)
      return calls.length === 1
        ? { results: [], count: 2, has_more: true, next_cursor: 'qq-next' }
        : { results: [], count: 2 }
    })

    await list({ source: 'imap_qq', limit: 20, offset: 0 })
    await list({ source: 'imap_gmail', limit: 20, offset: 20 })

    expect(calls[1]).toEqual({ source: 'imap_gmail', limit: 20, offset: 20 })
  })

  it('clears cached cursors when auth scope changes', async () => {
    let scope = 'user-a'
    const calls = []
    const list = createCursorAwareListEmails(async (params) => {
      calls.push(params)
      if (calls.length === 1) return { has_more: true, next_cursor: 'user-a-next' }
      return { results: [], count: 0 }
    }, () => scope)

    await list({ limit: 20, offset: 0 })
    scope = 'user-b'
    await list({ limit: 20, offset: 20 })

    expect(calls[1]).toEqual({ limit: 20, offset: 20 })
  })

  it('first-page refresh replaces stale next-page cursor', async () => {
    const calls = []
    const cursors = ['old-next', 'new-next']
    let firstPages = 0
    const list = createCursorAwareListEmails(async (params) => {
      calls.push(params)
      if (!('cursor' in params) && !('offset' in params)) {
        return { has_more: true, next_cursor: cursors[firstPages++] }
      }
      return { has_more: false, next_cursor: null }
    })

    await list({ limit: 20, offset: 0 })
    await list({ limit: 20, offset: 0 })
    await list({ limit: 20, offset: 20 })

    expect(calls[2]).toEqual({ limit: 20, cursor: 'new-next' })
  })

  it('does not let an older out-of-order refresh overwrite a newer cursor boundary', async () => {
    const calls = []
    const resolvers = []
    const list = createCursorAwareListEmails((params) => {
      calls.push(params)
      return new Promise((resolve) => resolvers.push(resolve))
    })

    const oldRefresh = list({ limit: 20, offset: 0 })
    const newRefresh = list({ limit: 20, offset: 0 })

    resolvers[1]({ has_more: true, next_cursor: 'new-next' })
    await newRefresh
    resolvers[0]({ has_more: true, next_cursor: 'old-next' })
    await oldRefresh

    const nextPage = list({ limit: 20, offset: 20 })
    expect(calls[2]).toEqual({ limit: 20, cursor: 'new-next' })
    resolvers[2]({ has_more: false, next_cursor: null })
    await nextPage
  })

  it('preserves explicit cursor calls and invalid pagination shapes unchanged', async () => {
    const calls = []
    const list = createCursorAwareListEmails(async (params) => {
      calls.push(params)
      return {}
    })

    await list({ limit: 20, cursor: 'caller-owned' })
    await list({ limit: 0, offset: 0 })
    await list({ limit: 20, offset: 3 })

    expect(calls).toEqual([
      { limit: 20, cursor: 'caller-owned' },
      { limit: 0, offset: 0 },
      { limit: 20, offset: 3 },
    ])
  })
})
