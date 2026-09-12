import assert from 'node:assert/strict'
import test from 'node:test'

// Keep this test source-local and dependency-free: it validates the provider
// capability rules by exercising the exported helpers from mutation_jobs.ts.
import {
  inferMutationProvider,
  providerMutationSupport,
} from './mutation_jobs.ts'

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
