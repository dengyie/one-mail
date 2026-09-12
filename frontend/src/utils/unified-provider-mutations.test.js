import { describe, expect, it, vi } from 'vitest'

import {
  createMutationStatusFetcher,
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
      sleepImpl: async () => {},
    })

    const result = await api.unified.toggleStar('m1')
    expect(result.status).toBe('succeeded')
    expect(result.is_starred).toBe(1)
    expect(fetchStatus).toHaveBeenCalledTimes(2)
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
    installUnifiedProviderMutations(api, () => ({ userJwt: jwt }), { fetchStatus })

    await expect(api.unified.markRead('m1')).rejects.toThrow('登录身份已变化')
    expect(fetchStatus).not.toHaveBeenCalled()
  })
})


describe('createMutationStatusFetcher', () => {
  it('uses login JWT first and never sends the API key in parallel', async () => {
    const fetchImpl = vi.fn(async (_url, options) => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'succeeded' }),
      options,
    }))
    const fetchStatus = createMutationStatusFetcher({ apiBase: 'https://api.example', fetchImpl })
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
})
