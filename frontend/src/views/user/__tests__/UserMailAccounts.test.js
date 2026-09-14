/**
 * Contract-level regression checks for the external mailbox form.
 * The view owns these presets, so keep the checks close to the view rather
 * than duplicating provider data in a second production module.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const view = readFileSync(fileURLToPath(new URL('../UserMailAccounts.vue', import.meta.url)), 'utf8')

describe('external mailbox provider form contract', () => {
    it('defines IMAP and POP3 defaults for providers that support both', () => {
        for (const [imapHost, pop3Host] of [
            ['imap.gmail.com', 'pop.gmail.com'],
            ['imap.qq.com', 'pop.qq.com'],
            ['imap.163.com', 'pop.163.com'],
            ['imap.126.com', 'pop.126.com'],
            ['imap.mail.yahoo.com', 'pop.mail.yahoo.com'],
        ]) {
            expect(view).toContain(`host: '${imapHost}'`)
            expect(view).toContain(`pop3Host: '${pop3Host}', pop3Port: 995`)
        }
    })

    it('makes Outlook an IMAP-only OAuth preset', () => {
        expect(view).toContain("value: 'outlook', source: 'imap_outlook'")
        expect(view).toContain("host: 'outlook.office365.com'")
        expect(view).toContain("pop3Host: '', pop3Port: 995, protocol: 'imap'")
        expect(view).toContain("const isOutlook = computed(() => form.value.provider === 'outlook')")
        expect(view).toContain(':disabled="isOutlook"')
        expect(view).toContain('v-model:value="form.oauth_json"')
        expect(view).toContain('msa_authorize.py')
    })

    it('validates the Outlook OAuth shapes already supported by the aggregator', () => {
        expect(view).toContain("new Set(['msa', 'hotmail', 'outlook_personal', 'outlook'])")
        expect(view).toContain("String(value.client_id || '').trim()")
        expect(view).toContain("String(value.refresh_token || '').trim()")
        expect(view).toContain("provider === 'outlook'")
        expect(view).toContain("String(value.client_secret || '').trim()")
    })

    it('submits OAuth through the existing mail-account API without using Basic Auth', () => {
        expect(view).toContain("const OAUTH_CRED_PLACEHOLDER = '__oauth_managed__'")
        expect(view).toContain('const effectiveCred = outlookOauth ? OAUTH_CRED_PLACEHOLDER : f.cred')
        expect(view).toContain('cred: effectiveCred')
        expect(view).toContain('oauth: outlookOauth?.text')
    })

    it('adds iCloud as an IMAP-only standard provider preset', () => {
        expect(view).toContain("label: 'iCloud Mail'")
        expect(view).toContain("host: 'imap.mail.me.com'")
        expect(view).toContain("protocol: 'imap'")
    })

    it('reuses imap_custom for new standard providers instead of backend branches', () => {
        for (const value of ['126', 'icloud', 'yahoo']) {
            expect(view).toContain(`value: '${value}', source: 'imap_custom'`)
        }
        expect(view).toContain('v-model:value="form.provider"')
        expect(view).toContain('form.value.source = opt.source')
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