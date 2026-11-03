import assert from 'node:assert/strict'
import test from 'node:test'

// Regression: all three claim endpoints must keep a constant number of D1 round
// trips no matter how many jobs are in the batch. Pre-fix each candidate was
// leased with its own `await DB.prepare(...).run()`, so a full batch (20 or 50
// jobs) issued 20-50 extra serial round trips on top of the fixed ones. With the
// aggregator's fixed 15s read timeout those batches reliably timed out
// (mutation batch incomplete: primary claim: ReadTimeout).
import { claimMutationJobs } from './mutation_jobs.ts'
import { claimLegacyMutationJobs } from './mutation_claim_legacy.ts'
import { claimOutboundJobs } from './outbound_jobs.ts'

/**
 * Fake D1 that counts round trips and routes SELECT results by SQL shape.
 * `batch()` counts as ONE round trip (D1 executes the statements server-side).
 */
const makeClaimingDb = ({ candidates, claimed }) => {
    const roundtrips = { total: 0, batch: 0, individual: 0 }
    const db = {
        prepare(sql) {
            const stmt = {
                bind() {
                    return stmt
                },
                async run() {
                    roundtrips.total += 1
                    roundtrips.individual += 1
                    return { meta: { changes: 1 } }
                },
                async all() {
                    roundtrips.total += 1
                    roundtrips.individual += 1
                    const claimedSelect = /lease_token = \?/.test(sql)
                        && /FROM (mail_mutation_jobs|outbound_mail_jobs)/.test(sql)
                    if (claimedSelect) return { results: claimed }
                    if (/SELECT/.test(sql)) return { results: candidates }
                    return { results: [] }
                },
                async first() {
                    roundtrips.total += 1
                    roundtrips.individual += 1
                    return null
                },
            }
            return stmt
        },
        async batch(statements) {
            roundtrips.total += 1
            roundtrips.batch += 1
            return statements.map(() => ({ meta: { changes: 1 } }))
        },
    }
    return { db, roundtrips }
}

const claimContext = (db, limit) => ({
    req: { json: async () => ({ lease_token: 'lease-1', limit }) },
    env: { DB: db },
    json: (body, status) => ({ body, status }),
})

test('claimMutationJobs stays at a constant round-trip budget for a full 20-job batch', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
        id: `m${i}`, email_id: `e${i}`, operation: 'set_read',
    }))
    const { db, roundtrips } = makeClaimingDb({ candidates: rows, claimed: rows })
    const res = await claimMutationJobs(claimContext(db, 20))
    assert.equal(res.body.jobs.length, 20)
    assert.ok(res.body.lease_until > 0)
    // recover+collapse batch (1) + candidate select (1) + lease batch (1) + claimed select (1)
    assert.ok(roundtrips.total <= 4,
        `expected <=4 D1 round trips for 20 jobs, got ${roundtrips.total}`)
})

test('claimLegacyMutationJobs stays at a constant round-trip budget for a full batch', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: `l${i}`, email_id: `e${i}` }))
    const { db, roundtrips } = makeClaimingDb({ candidates: rows, claimed: rows })
    const res = await claimLegacyMutationJobs(claimContext(db, 50))
    assert.equal(res.body.jobs.length, 50)
    assert.equal(res.body.claim_version, 1)
    assert.ok(roundtrips.total <= 4,
        `expected <=4 D1 round trips for 50 jobs, got ${roundtrips.total}`)
})

test('claimOutboundJobs stays at a constant round-trip budget for a full 50-job batch', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => ({ id: `o${i}` }))
    const rows = ids.map(({ id }) => ({ id, account_id: 'acc-1' }))
    const { db, roundtrips } = makeClaimingDb({ candidates: ids, claimed: rows })
    const res = await claimOutboundJobs(claimContext(db, 50))
    assert.equal(res.body.jobs.length, 50)
    assert.ok(res.body.lease_until > 0)
    assert.ok(roundtrips.total <= 4,
        `expected <=4 D1 round trips for 50 jobs, got ${roundtrips.total}`)
})