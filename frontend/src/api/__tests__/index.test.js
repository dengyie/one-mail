/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest'
import { normalizeMailAccountBody, api } from '../index'

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

describe('getOpenSettings defensive guards', () => {
    it('handles missing notification and message objects gracefully without throwing TypeError', async () => {
        // Mock api.fetch to reject
        const fetchSpy = vi.spyOn(api, 'fetch').mockRejectedValueOnce(new Error('Network offline'))
        
        // Calling getOpenSettings with undefined message should not throw TypeError
        await expect(api.getOpenSettings(undefined, undefined)).resolves.not.toThrow()

        // Calling getOpenSettings with empty message object should not throw
        await expect(api.getOpenSettings({}, undefined)).resolves.not.toThrow()

        fetchSpy.mockRestore()
    })

    it('safely handles announcement display when notification is omitted or lacks info method', async () => {
        const fetchSpy = vi.spyOn(api, 'fetch').mockResolvedValueOnce({
            announcement: '<b>Maintenance window notice</b>',
            alwaysShowAnnouncement: true
        })

        // When notification is undefined, should not crash
        await expect(api.getOpenSettings(undefined, undefined)).resolves.not.toThrow()

        fetchSpy.mockRestore()
    })
})
