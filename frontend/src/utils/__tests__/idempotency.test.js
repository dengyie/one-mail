import { describe, expect, it, beforeEach } from 'vitest'
import { clearSendMailIdempotencyKey, getSendMailIdempotencyKey } from '../idempotency'

describe('send-mail idempotency keys', () => {
    beforeEach(() => sessionStorage.clear())

    it('reuses a key for the same channel until cleared', () => {
        const first = getSendMailIdempotencyKey('user')
        expect(first).toBe(getSendMailIdempotencyKey('user'))
        expect(first.length).toBeGreaterThan(10)
        clearSendMailIdempotencyKey('user')
        expect(getSendMailIdempotencyKey('user')).not.toBe(first)
    })

    it('keeps admin and user channels separate', () => {
        expect(getSendMailIdempotencyKey('admin')).not.toBe(getSendMailIdempotencyKey('user'))
    })
})
