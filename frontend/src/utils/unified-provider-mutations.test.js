import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUnifiedMutationApi, waitForMutationTerminal } from './unified-provider-mutations'
const auth = { key: 'user-a', headers: { 'x-user-token': 'jwt-a' } }
const getAuth = () => auth
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
afterEach(() => vi.useRealTimers())

describe('provider terminal protocol', () => {
  it('waits through pending and processing to authoritative success', async () => {
    const fetchStatus = vi.fn().mockResolvedValueOnce({ status: 'pending' }).mockResolvedValueOnce({ status: 'processing' })
      .mockResolvedValueOnce({ status: 'succeeded', desired_value: 0 })
    const result = await waitForMutationTerminal('job', { getAuth, fetchStatus, sleepImpl: async () => {} })
    expect(result).toEqual({ status: 'succeeded', desired_value: 0 })
    expect(fetchStatus).toHaveBeenCalledTimes(3)
  })
  it.each(['failed', 'unsupported', 'superseded'])('surfaces terminal %s', async status => {
    await expect(waitForMutationTerminal('job', { getAuth, fetchStatus: async () => ({ status, error: 'provider refused' }) }))
      .rejects.toMatchObject({ code: `mutation_${status}`, message: 'provider refused' })
  })
  it('rejects missing job IDs and malformed statuses', async () => {
    await expect(waitForMutationTerminal('', { getAuth, fetchStatus: vi.fn() })).rejects.toThrow('no job id')
    await expect(waitForMutationTerminal('job', { getAuth, fetchStatus: async () => ({}) })).rejects.toMatchObject({ code: 'mutation_invalid_status' })
  })
  it('bounds an in-flight request, including a response body that never completes', async () => {
    vi.useFakeTimers()
    let activeSignal
    const fetchStatus = vi.fn((_id, _auth, { signal }) => { activeSignal = signal; return new Promise(() => {}) })
    const pending = waitForMutationTerminal('job', { getAuth, fetchStatus, timeoutMs: 50 })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'mutation_pending' })
    await vi.advanceTimersByTimeAsync(50); await rejected
    expect(activeSignal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('stops during a polling delay and releases timers on cancellation', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const fetchStatus = vi.fn(async () => ({ status: 'pending' }))
    const pending = waitForMutationTerminal('job', { getAuth, fetchStatus, signal: controller.signal })
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await flush(); controller.abort(); await rejected
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchStatus).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('checks cancellation before issuing a status request', async () => {
    const controller = new AbortController(); controller.abort()
    const fetchStatus = vi.fn()
    await expect(waitForMutationTerminal('job', { getAuth, fetchStatus, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchStatus).not.toHaveBeenCalled()
  })
  it('rejects identity changes during a response and never polls the new scope', async () => {
    let current = auth
    await expect(waitForMutationTerminal('job', {
      getAuth: () => current,
      fetchStatus: async () => { current = { key: 'admin-b', headers: {} }; return { status: 'succeeded' } },
    })).rejects.toMatchObject({ code: 'mutation_auth_changed' })
  })
  it('releases the deadline and parent listener after success', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    await waitForMutationTerminal('job', { getAuth, signal: controller.signal, fetchStatus: async () => ({ status: 'succeeded' }) })
    expect(vi.getTimerCount()).toBe(0)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})

describe('all writes share the terminal protocol', () => {
  it.each([
    ['markRead', ['m/1'], '/api/unified/emails/m%2F1/read', 'POST', undefined, { is_read: 1 }],
    ['markUnread', ['m/1'], '/api/unified/emails/m%2F1/unread', 'POST', undefined, { is_read: 0 }],
    ['toggleStar', ['m/1', 1], '/api/unified/emails/m%2F1/star', 'POST', { is_starred: 1 }, { is_starred: 1 }],
    ['moveEmail', ['m/1', 17], '/api/unified/emails/m%2F1/move', 'POST', { folder_id: 17 }, { source_folder: 'Archive', source_folder_id: 'f-17' }],
    ['deleteEmail', ['m/1'], '/api/unified/emails/m%2F1', 'DELETE', undefined, { deleted: true }],
  ])('%s waits for queued completion', async (method, args, path, verb, body, expected) => {
    const desired = method === 'markUnread' ? 0 : 1
    const request = vi.fn().mockResolvedValueOnce({ status: 'queued', job_id: 'j/1' })
      .mockResolvedValueOnce({ status: 'succeeded', desired_value: desired, target_folder: 'Archive', target_folder_id: 'f-17' })
    const api = createUnifiedMutationApi({ request, getAuth })
    await expect(api[method](...args)).resolves.toMatchObject(expected)
    expect(request.mock.calls[0][0]).toBe(path)
    expect(request.mock.calls[0][1].method).toBe(verb)
    expect(request.mock.calls[0][1].body).toEqual(body)
    expect(request.mock.calls[1][0]).toBe('/api/unified/mutations/j%2F1')
  })
  it('preserves native immediate success without starting polling', async () => {
    const request = vi.fn(async () => ({ status: 'succeeded', desired_value: 1 }))
    const api = createUnifiedMutationApi({ request, getAuth })
    await expect(api.toggleStar('m', 1)).resolves.toMatchObject({ is_starred: 1 })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('does not let the original queued desired value replace the terminal value', async () => {
    const request = vi.fn().mockResolvedValueOnce({ status: 'queued', job_id: 'j', desired_value: 1 })
      .mockResolvedValueOnce({ status: 'succeeded', desired_value: 0 })
    await expect(createUnifiedMutationApi({ request, getAuth }).toggleStar('m', 1)).resolves.toMatchObject({ is_starred: 0 })
  })
  it('passes through the HTTP error with its original cause', async () => {
    const cause = new Error('socket closed')
    const error = new Error('request failed', { cause })
    const request = vi.fn().mockRejectedValue(error)
    await expect(createUnifiedMutationApi({ request, getAuth }).markRead('m')).rejects.toBe(error)
  })
})
