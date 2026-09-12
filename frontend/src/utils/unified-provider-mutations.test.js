import { describe, expect, it, vi } from 'vitest'

import {
  createMutationStatusFetcher,
  createUnifiedMutationTransport,
  installUnifiedProviderMutations,
  waitForMutationTerminal,
} from './unified-provider-mutations'


describe('waitForMutationTerminal', () => {
  it('waits through processing and returns only terminal success', async () => {
    const statuses = [
      { status: 'processing' },
      { status: 'succeeded', desired_value: 1 },
    ]
    const fetchStatus = vi.fn(async () => statuses.shift())
    const result = await waitForMutationTerminal('job-1', {
      getAuth: () => ({ userJwt: 'jwt-a' }),
      fetchStatus,
      sleepImpl: async () => {},
    })

    expect(result.status).toBe('succeeded')
    expect(fetchStatus).toHaveBeenCalledTimes(2)
  })

  it('surfaces provider terminal failure instead of pretending success', async () => {
    await expect(waitForMutationTerminal('job-2', {
      getAuth: () => ({ apiKey: 'key-a' }),
      fetchStatus: async () => ({ status: 'failed', error: 'IMAP permission denied' }),
      sleepImpl: async () => {},
    })).rejects.toThrow('IMAP permission denied')
  })
})


describe('installUnifiedProviderMutations', () => {
  it('keeps synchronous native mutation behavior unchanged', async () => {
    const api = {
      unified: {
        markRead: vi.fn(async () => ({ status: 'succeeded', desired_value: 1, is_read: 1 })),
        toggleStar: vi.fn(async () => ({ status: 'succeeded', desired_value: 1, is_starred: 1 })),
      },
    }
    installUnifiedProviderMutations(api, () => ({ userJwt: 'jwt-a' }), {
      fetchStatus: vi.fn(),
      transport: vi.fn(),
    })

    await expect(api.unified.markRead('m1')).resolves.toMatchObject({ status: 'succeeded', is_read: 1 })
    await expect(api.unified.toggleStar('m1')).resolves.toMatchObject({ status: 'succeeded', is_starred: 1 })
  })

  it('does not resolve a queued star until provider completion', async () => {
    const fetchStatus = vi.fn()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'succeeded', desired_value: 1 })
    const api = {
      unified: {
        markRead: vi.fn(),
        toggleStar: vi.fn(async () => ({ status: 'queued', job_id: 'j-star', desired_value: 1 })),
      },
    }
    installUnifiedProviderMutations(api, () => ({ userJwt: 'jwt-a' }), {
      fetchStatus,
      transport: vi.fn(),
      sleepImpl: async () => {},
    })

    const result = await api.unified.toggleStar('m1')
    expect(result.status).toBe('succeeded')
    expect(result.is_starred).toBe(1)
    expect(fetchStatus).toHaveBeenCalledTimes(2)
  })

  it('waits for move completion and maps the terminal target folder', async () => {
    const transport = vi.fn(async (path, options) => {
      expect(path).toBe('/api/unified/emails/m%2F1/move')
      expect(options).toMatchObject({
        method: 'POST',
        body: { folder_id: 17 },
        auth: { key: 'user:jwt-a', headers: { 'x-user-token': 'jwt-a' } },
      })
      return { status: 'queued', job_id: 'j-move', target_folder: 'Archive' }
    })
    const fetchStatus = vi.fn()
      .mockResolvedValueOnce({ status: 'processing' })
      .mockResolvedValueOnce({
        status: 'succeeded',
        operation: 'move',
        target_folder: 'Archive',
        target_folder_id: 'folder-17',
      })
    const api = { unified: { markRead: vi.fn(), toggleStar: vi.fn() } }
    installUnifiedProviderMutations(api, () => ({ userJwt: 'jwt-a', apiKey: 'must-not-leak' }), {
      transport,
      fetchStatus,
      sleepImpl: async () => {},
    })

    await expect(api.unified.moveEmail('m/1', 17)).resolves.toMatchObject({
      status: 'succeeded',
      source_folder: 'Archive',
      source_folder_id: 'folder-17',
    })
    expect(fetchStatus).toHaveBeenCalledTimes(2)
  })

  it('does not report queued delete as complete before terminal provider success', async () => {
    const transport = vi.fn(async () => ({ status: 'queued', job_id: 'j-delete' }))
    const fetchStatus = vi.fn()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'succeeded', operation: 'delete' })
    const api = { unified: { markRead: vi.fn(), toggleStar: vi.fn() } }
    installUnifiedProviderMutations(api, () => ({ apiKey: 'key-a' }), {
      transport,
      fetchStatus,
      sleepImpl: async () => {},
    })

    await expect(api.unified.deleteEmail('m1')).resolves.toMatchObject({
      status: 'succeeded',
      deleted: true,
    })
    expect(transport.mock.calls[0][0]).toBe('/api/unified/emails/m1')
    expect(transport.mock.calls[0][1]).toMatchObject({
      method: 'DELETE',
      auth: { key: 'key:key-a', headers: { Authorization: 'Bearer key-a' } },
    })
  })

  it('lists folders through the same single auth snapshot', async () => {
    const transport = vi.fn(async () => ({ results: [{ id: 1, canonical_name: 'INBOX' }] }))
    const api = { unified: { markRead: vi.fn(), toggleStar: vi.fn() } }
    installUnifiedProviderMutations(api, () => ({ userJwt: 'jwt-a' }), { transport, fetchStatus: vi.fn() })

    await expect(api.unified.listFolders({ account_id: 'a/1' })).resolves.toMatchObject({
      results: [{ id: 1, canonical_name: 'INBOX' }],
    })
    expect(transport.mock.calls[0][0]).toBe('/api/unified/folders?account_id=a%2F1')
    expect(transport.mock.calls[0][1].auth.headers).toEqual({ 'x-user-token': 'jwt-a' })
  })

  it('aborts UI completion when auth identity changes while a job is queued', async () => {
    let jwt = 'jwt-a'
    const api = {
      unified: {
        markRead: vi.fn(async () => {
          jwt = 'jwt-b'
          return { status: 'queued', job_id: 'j-read', desired_value: 1 }
        }),
        toggleStar: vi.fn(),
      },
    }
    const fetchStatus = vi.fn()
    installUnifiedProviderMutations(api, () => ({ userJwt: jwt }), { fetchStatus, transport: vi.fn() })

    await expect(api.unified.markRead('m1')).rejects.toThrow('登录身份已变化')
    expect(fetchStatus).not.toHaveBeenCalled()
  })
})


describe('raw provider mutation transport', () => {
  it('uses login JWT first for status polling and never sends the API key in parallel', async () => {
    const fetchImpl = vi.fn(async (_url, options) => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'succeeded' }),
      options,
    }))
    const fetchStatus = createMutationStatusFetcher({ apiBase: 'https://api.example/', fetchImpl })
    const result = await fetchStatus('job/1', {
      headers: { 'x-user-token': 'jwt-a' },
    })

    expect(result.status).toBe('succeeded')
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.example/api/unified/mutations/job%2F1')
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({
      Accept: 'application/json',
      'x-user-token': 'jwt-a',
    })
  })

  it('serializes JSON only for mutating requests and surfaces response errors', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ status: 'queued' }) })
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: 'bad folder' }) })
    const transport = createUnifiedMutationTransport({ apiBase: 'https://api.example', fetchImpl })

    await expect(transport('/api/unified/emails/m1/move', {
      method: 'POST',
      body: { folder_id: 9 },
      auth: { headers: { 'x-user-token': 'jwt-a' } },
    })).resolves.toEqual({ status: 'queued' })
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ folder_id: 9 }),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-user-token': 'jwt-a',
      },
    })

    await expect(transport('/api/unified/folders', {
      auth: { headers: { 'x-user-token': 'jwt-a' } },
    })).rejects.toThrow('bad folder')
    expect(fetchImpl.mock.calls[1][1].body).toBeUndefined()
  })
})