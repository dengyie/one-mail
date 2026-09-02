/** @vitest-environment jsdom */

import { describe, expect, it } from 'vitest'
import { normalizeMailAccountBody } from '../index'

describe('mail account request body', () => {
    it('passes object JSON bodies through and parses legacy serialized bodies', () => {
        const body = {
            protocol: 'pop3',
            use_ssl: true,
            pop3_host: 'pop.example.com',
            pop3_port: 995,
            pop3_ssl: true,
            pop3_use_stls: false,
        }
        expect(normalizeMailAccountBody(body)).toBe(body)
        expect(normalizeMailAccountBody(JSON.stringify(body))).toEqual(body)
    })

    it('rejects invalid legacy bodies', () => {
        expect(() => normalizeMailAccountBody('{invalid')).toThrow('valid JSON')
        expect(() => normalizeMailAccountBody('[]')).toThrow('JSON object')
    })
})
