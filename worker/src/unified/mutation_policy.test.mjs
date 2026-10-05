import assert from 'node:assert/strict'
import test from 'node:test'

// Keep this test source-local and dependency-free: it validates the provider
// capability rules by exercising the exported helpers from mutation_jobs.ts.
import {
  inferMutationProvider,
  providerMutationSupport,
  claimMutationJobs,
  reportMutationResult,
} from './mutation_jobs.ts'
import { claimLegacyMutationJobs } from './mutation_claim_legacy.ts'

test('malformed JSON claim/result requests retain typed empty-body fallback', async () => {
  const c = {
    req: { json: async () => { throw new SyntaxError('invalid json') } },
    json: (body, status) => ({ body, status }),
  }
  assert.deepEqual(await claimMutationJobs(c), { body: { error: 'invalid claim request' }, status: 400 })
  assert.deepEqual(await claimLegacyMutationJobs(c), { body: { error: 'invalid claim request' }, status: 400 })
  assert.deepEqual(await reportMutationResult(c), { body: { error: 'invalid mutation result' }, status: 400 })
})

const base = {
  id: 'm1',
  source: 'imap_custom',
  account_id: 'acc-1',
  to_addr: 'u@example.com',
  is_read: 0,
  is_starred: 0,
  provider: null,
  source_folder: 'INBOX',
  source_folder_id: null,
  provider_message_id: null,
  source_key: 'acc-1:imap.example.com:INBOX:7:42',
  imap_uid: 'acc-1:imap.example.com:INBOX:7:42',
}

test('provider inference distinguishes native, IMAP, Graph and POP3', () => {
  assert.equal(inferMutationProvider({ ...base, provider: 'native' }), 'native')
  assert.equal(inferMutationProvider(base), 'imap')
  assert.equal(inferMutationProvider({ ...base, provider: 'graph', provider_message_id: 'immutable-1' }), 'graph')
  assert.equal(inferMutationProvider({ ...base, provider: 'pop3', source_key: 'pop3:acc-1:INBOX:uidl' }), 'pop3')
})

test('Graph requires provider-stable message identity', () => {
  assert.deepEqual(
    providerMutationSupport({ ...base, provider: 'graph', provider_message_id: null }),
    { ok: false, provider: 'graph', code: 'missing_provider_message_identity' },
  )
  assert.deepEqual(
    providerMutationSupport({ ...base, provider: 'graph', provider_message_id: 'immutable-1' }),
    { ok: true, provider: 'graph' },
  )
})

test('IMAP requires stable folder and source identity while POP3 is unsupported', () => {
  assert.deepEqual(providerMutationSupport(base), { ok: true, provider: 'imap' })
  assert.deepEqual(
    providerMutationSupport({ ...base, source_folder: null }),
    { ok: false, provider: 'imap', code: 'missing_imap_message_identity' },
  )
  assert.deepEqual(
    providerMutationSupport({ ...base, provider: 'pop3', source_key: 'pop3:acc-1:INBOX:uidl' }),
    { ok: false, provider: 'pop3', code: 'provider_write_unsupported' },
  )
})

const mutationJob = {
  id: 'job-1', email_id: 'm1', account_id: 'acc-1', source: 'imap_custom', to_addr: 'u@example.com',
  provider: 'imap', operation: 'move', desired_value: null, source_folder: 'INBOX', source_folder_id: null,
  target_folder: 'Archive', target_folder_id: null, provider_message_id: null,
  source_key: 'acc-1:imap.example.com:INBOX:7:42', message_id_header: '<m1@example.com>',
  status: 'processing', attempts: 1, next_attempt_at: 0, lease_token: 'old-lease', lease_until: Date.now() + 1000,
}

test('reclaimed worker result cannot update projection or terminal state', async () => {
  const calls = []
  const db = {
    prepare(sql) {
      return {
        bind(...params) {
          calls.push({ sql, params })
          return {
            first: async () => sql.includes('SELECT * FROM mail_mutation_jobs') ? mutationJob : null,
            run: async () => ({ meta: { changes: 0 } }),
          }
        },
      }
    },
    batch: async statements => statements.map(() => ({ meta: { changes: 0 } })),
  }
  const c = {
    req: {
      param: () => 'job-1',
      json: async () => ({
        lease_token: 'old-lease', status: 'succeeded',
        projection: { source_folder: 'Archive', source_key: 'acc-1:imap.example.com:Archive:8:42' },
      }),
    },
    env: { DB: db },
    json: (body, status) => ({ body, status }),
  }
  const result = await reportMutationResult(c)
  assert.deepEqual(result, { body: { error: 'stale or unknown lease' }, status: 409 })
  assert.ok(calls.some(call => /lease_token/.test(call.sql)))
})
