import assert from 'node:assert/strict'
import test from 'node:test'

// Opening a mail must look read on every screen, not only after the aggregator
// finishes the provider round trip. The local row is the source of the UI, so
// the desired state has to be projected when the job is queued. A later
// terminal failure must never guess the pre-intent value back, because a
// superseded predecessor may have already moved it.
import { markRead, reportMutationResult } from './mutation_jobs.ts'

const emailRow = {
  id: 'm1',
  source: 'imap_gmail',
  account_id: 'acc-1',
  to_addr: 'u@example.com',
  is_read: 0,
  is_starred: 0,
  provider: 'imap',
  source_folder: 'INBOX',
  source_folder_id: null,
  provider_message_id: null,
  source_key: 'acc-1:imap.example.com:INBOX:7:42',
  imap_uid: 'acc-1:imap.example.com:INBOX:7:42',
  message_id_header: '<m1@example.com>',
}

const fakeDb = ({ job = null, newer = null } = {}) => {
  const calls = []
  const statements = []
  const db = {
    prepare(sql) {
      return {
        bind(...params) {
          const entry = {
            sql,
            params,
            first: async () => {
              if (sql.includes('FROM emails WHERE id = ?')) return emailRow
              if (sql.includes('SELECT * FROM mail_mutation_jobs')) return job
              return newer
            },
            run: async () => ({ success: true, meta: { changes: 1 } }),
          }
          calls.push(entry)
          statements.push(entry)
          return entry
        },
      }
    },
    batch: async batchStatements => {
      statements.push(...batchStatements)
      return batchStatements.map(() => ({ success: true, meta: { changes: 1 } }))
    },
  }
  return { db, calls, statements }
}

const workerContext = (db, { id = 'm1', body = {} } = {}) => ({
  req: { param: () => id, json: async () => body },
  env: { DB: db },
  // Admin scope keeps checkRowAccess out of the assertions without weakening
  // the production ownership path that federation tests already cover.
  get: (name) => (name === "unifiedUserAuth" ? { isAdmin: true } : undefined),
  json: (payload, status = 200) => ({ body: payload, status }),
})

const writesEmailColumn = (statements, column, value) => statements.some(
  (entry) => new RegExp(`UPDATE emails SET ${column} = \\?`).test(entry.sql) && entry.params[0] === value,
)

test('queueing a read mutation projects is_read=1 on the local row immediately', async () => {
  const { db, statements } = fakeDb()
  const result = await markRead(workerContext(db))

  assert.equal(result.status, 202)
  assert.equal(result.body.status, 'queued')
  assert.equal(result.body.desired_value, 1)
  // The visible row must not wait for the aggregator: detail, list, unread
  // count and the unread filter all read this column.
  assert.ok(
    writesEmailColumn(statements, 'is_read', 1),
    'expected an immediate UPDATE emails SET is_read = 1 when the job is queued',
  )
})

const processingJob = {
  ...emailRow,
  id: 'job-1',
  email_id: 'm1',
  operation: 'set_read',
  desired_value: 1,
  status: 'processing',
  attempts: 1,
  next_attempt_at: 0,
  lease_token: 'lease-1',
  lease_until: Date.now() + 60_000,
  last_error: null,
  created_at: 1,
  updated_at: 1,
  completed_at: null,
}

test('a terminal provider failure never rewrites the visible read state by guesswork', async () => {
  const { db, statements } = fakeDb({ job: processingJob })
  const result = await reportMutationResult(workerContext(db, {
    id: 'job-1',
    body: { lease_token: 'lease-1', status: 'failed', error: 'mailbox offline' },
  }))

  assert.equal(result.status, 200)
  assert.equal(result.body.status, 'failed')
  // read -> unread -> read leaves several optimistic writes behind, so the real
  // pre-intent value is unknowable here. Any rewrite (for example desired ^ 1)
  // would silently undo the user's last action.
  assert.equal(writesEmailColumn(statements, 'is_read', 0), false)
  assert.equal(writesEmailColumn(statements, 'is_read', 1), false)
})
