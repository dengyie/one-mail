/**
 * Contract-level regression checks for the external mailbox form.
 * The view owns these presets, so keep the checks close to the view rather
 * than duplicating provider data in a second production module.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const view = readFileSync(fileURLToPath(new URL('../UserMailAccounts.vue', import.meta.url)), 'utf8')

describe('external mailbox POP3 form contract', () => {
    it('defines IMAP and POP3 defaults together for every provider', () => {
        for (const [imapHost, pop3Host] of [
            ['imap.gmail.com', 'pop.gmail.com'],
            ['outlook.office365.com', 'outlook.office365.com'],
            ['imap.qq.com', 'pop.qq.com'],
            ['imap.163.com', 'pop.163.com'],
        ]) {
            expect(view).toContain(`host: '${imapHost}'`)
            expect(view).toContain(`pop3Host: '${pop3Host}', pop3Port: 995`)
        }
    })

    it('keeps the explicit auto fallback and POP3-only semantics visible', () => {
        expect(view).toContain("t('autoDescription')")
        expect(view).toContain("t('pop3OnlyDescription')")
        expect(view).toContain("v-if=\"form.protocol !== 'pop3'\"")
    })

    it('renders both sync timestamp and the latest error field', () => {
        expect(view).toContain("key: 'last_sync_at'")
        expect(view).toContain("key: 'last_error'")
    })
})
