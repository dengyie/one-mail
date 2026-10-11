// @vitest-environment jsdom
import { createApp, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ShardMaintenance from '../ShardMaintenance.vue'

const { fetchApi, message } = vi.hoisted(() => ({
  fetchApi: vi.fn(),
  message: { success: vi.fn(), error: vi.fn() },
}))
vi.mock('@/api', () => ({ api: { fetch: fetchApi } }))
// The interpolated params must be visible in the DOM to assert what the view
// passes to i18n, so the identity `t` appends the params it received.
vi.mock('@/i18n/app', () => ({ useScopedI18n: () => ({ t: (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key) }) }))
vi.mock('naive-ui', async importOriginal => ({ ...await importOriginal(), useMessage: () => message }))

const mounted = []
const shard = overrides => ({
  id: 'shard-b',
  base_url: 'https://shard-b.example.com',
  account_ids: ['acc-1'],
  reachable: true,
  unavailable_reason: null,
  reported_shard_id: 'shard-b',
  shard_mode: true,
  ...overrides,
})
const shardList = overrides => ({
  primary: { shard_id: 'primary', is_shard_mode: false },
  shards: [shard()],
  registry_error: null,
  ...overrides,
})
const queues = { shards: [], action: [] }
const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); await nextTick() }
const button = (host, label) => [...host.querySelectorAll('button')].find(el => el.textContent.trim() === label)
async function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(ShardMaintenance)
  app.mount(host)
  const unmount = () => { app.unmount(); host.remove() }
  mounted.push(unmount)
  await flush()
  return { host, unmount }
}

beforeEach(() => {
  vi.clearAllMocks()
  fetchApi.mockReset()
  queues.shards.length = 0
  queues.action.length = 0
  // Route by path instead of call order: mount fires one GET and maintenance
  // appends a POST plus a refresh GET, so ordered mocks would be fragile.
  fetchApi.mockImplementation(async (path, options = {}) => {
    if (path === '/admin/db_shards') {
      if (queues.shards.length) return queues.shards.shift()
      return shardList()
    }
    if (path === '/admin/db_shard_initialize') {
      if (queues.action.length) return queues.action.shift()
      return { ok: true, shard_id: options.body?.shard_id, message: 'Shard schema initialized' }
    }
    throw new Error(`unexpected api path: ${path}`)
  })
})
afterEach(() => { for (const unmount of mounted.splice(0)) unmount() })

describe('shard list rendering', () => {
  it('renders the registered shard with its endpoint, assignment and reachability', async () => {
    const { host } = await mount()
    expect(host.textContent).toContain('shard-b')
    expect(host.textContent).toContain('https://shard-b.example.com')
    expect(host.textContent).toContain('assignedAccounts {"count":1}')
    expect(host.textContent).toContain('reachable')
    expect(button(host, 'initialize')).toBeDefined()
  })

  it('shows the empty-registry note and offers no maintenance actions', async () => {
    queues.shards.push(shardList({ shards: [] }))
    const { host } = await mount()
    expect(host.textContent).toContain('noShards')
    expect(button(host, 'initialize')).toBeUndefined()
  })

  it('surfaces a malformed registry distinctly from an empty one', async () => {
    queues.shards.push(shardList({ shards: [], registry_error: 'invalid_shard_map' }))
    const { host } = await mount()
    expect(host.textContent).toContain('registryError')
    expect(host.textContent).not.toContain('noShards')
    expect(button(host, 'initialize')).toBeUndefined()
  })

  it('rejects a malformed shard list response and recovers via refresh', async () => {
    queues.shards.push({ primary: { shard_id: 'primary' } })
    const { host } = await mount()
    expect(host.textContent).toContain('invalidShardList')
    button(host, 'refresh').click()
    await flush()
    expect(host.textContent).toContain('shard-b')
    expect(host.textContent).not.toContain('invalidShardList')
  })

  it('disables maintenance on an unreachable shard and shows the transport reason', async () => {
    queues.shards.push(shardList({ shards: [shard({ reachable: false, unavailable_reason: 'timeout' })] }))
    const { host } = await mount()
    expect(host.textContent).toContain('unreachable {"reason":"timeout"}')
    const action = button(host, 'initialize')
    expect(action).toBeDefined()
    expect(action.disabled).toBe(true)
  })
})

describe('shard schema maintenance', () => {
  it('posts the shard id and refreshes the list after success', async () => {
    const { host } = await mount()
    button(host, 'initialize').click()
    await flush()
    expect(fetchApi.mock.calls.map(([path]) => path))
      .toEqual(['/admin/db_shards', '/admin/db_shard_initialize', '/admin/db_shards'])
    expect(fetchApi.mock.calls[1][1]).toMatchObject({ method: 'POST', body: { shard_id: 'shard-b' } })
    expect(message.success).toHaveBeenCalledExactlyOnceWith('initializeSuccess {"id":"shard-b"}')
    expect(message.error).not.toHaveBeenCalled()
  })

  it('issues a single request for repeated clicks while the operation is pending', async () => {
    const pending = deferred()
    queues.action.push(pending.promise)
    const { host } = await mount()
    const action = button(host, 'initialize')
    action.click()
    action.click()
    await flush()
    expect(fetchApi.mock.calls.filter(([path]) => path === '/admin/db_shard_initialize')).toHaveLength(1)
    expect(action.disabled).toBe(true)
    pending.resolve({ ok: true })
    await flush()
    expect(message.success).toHaveBeenCalledTimes(1)
  })

  it('reports a failed maintenance with the transport reason and no success message', async () => {
    queues.action.push(Promise.reject(new Error('Code 502: http_500')))
    const { host } = await mount()
    button(host, 'initialize').click()
    await flush()
    expect(message.success).not.toHaveBeenCalled()
    expect(message.error).toHaveBeenCalledExactlyOnceWith(
      'initializeFailed {"id":"shard-b","reason":"Code 502: http_500"}')
    expect(fetchApi.mock.calls.filter(([path]) => path === '/admin/db_shards')).toHaveLength(1)
  })
})

describe('view lifecycle', () => {
  it('aborts a pending list read when the view is removed', async () => {
    const pending = deferred()
    queues.shards.push(pending.promise)
    const { unmount } = await mount()
    const options = fetchApi.mock.calls[0][1]
    unmount()
    mounted.pop()
    expect(options.signal.aborted).toBe(true)
    pending.reject(new Error('cancelled'))
    await flush()
    expect(message.error).not.toHaveBeenCalled()
  })

  it('does not announce a completed maintenance after the view is removed', async () => {
    const pending = deferred()
    queues.action.push(pending.promise)
    const { host, unmount } = await mount()
    button(host, 'initialize').click()
    await flush()
    unmount()
    mounted.pop()
    pending.resolve({ ok: true })
    await flush()
    expect(fetchApi.mock.calls).toHaveLength(2)
    expect(message.success).not.toHaveBeenCalled()
  })
})
