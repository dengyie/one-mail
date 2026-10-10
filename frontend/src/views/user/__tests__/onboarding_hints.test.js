import { describe, expect, it } from 'vitest'
import { getProviderContextHint, PROVIDER_CONTEXT_HINTS } from '../onboarding_hints.js'
import { I18N_MESSAGES } from '../../../i18n/messages'
import { SUPPORTED_LOCALES } from '../../../i18n/locale-registry'

const resolveMessage = (locale, path) =>
    path.split('.').reduce((node, segment) => (node == null ? node : node[segment]), I18N_MESSAGES[locale])

describe('onboarding provider hints contract', () => {
    it('accurately identifies linux.do and points to the i18n keys for the empty-IP warning', () => {
        const hint = getProviderContextHint('mangoqwq@linux.do')
        expect(hint).toBeTruthy()
        expect(hint.providerKey).toBe('linux_do')
        expect(hint.badgeKey).toContain('linuxDo.badge')
        expect(hint.warningKey).toContain('linuxDo.warning')
    })

    it('keeps the linux.do empty-authorized-IP guidance in the source locale copy', () => {
        const warning = resolveMessage('zh', 'providerHints.linuxDo.warning')
        expect(warning).toContain('授权IP')
        expect(warning).toContain('留空')
    })

    it('identifies qq and foxmail addresses', () => {
        const qqHint = getProviderContextHint('user@qq.com')
        expect(qqHint).toBeTruthy()
        expect(qqHint.providerKey).toBe('qq')
        expect(qqHint.warningKey).toContain('qq.warning')

        const foxHint = getProviderContextHint('user@foxmail.com')
        expect(foxHint).toBeTruthy()
        expect(foxHint.providerKey).toBe('qq')
    })

    it('identifies netease 163 and 126 domains', () => {
        const hint163 = getProviderContextHint('my_mail@163.com')
        expect(hint163).toBeTruthy()
        expect(hint163.providerKey).toBe('netease')

        const hint126 = getProviderContextHint('my_mail@126.com')
        expect(hint126).toBeTruthy()
        expect(hint126.providerKey).toBe('netease')
    })

    it('identifies google gmail and points to the app-password warning key', () => {
        const hint = getProviderContextHint('user@gmail.com')
        expect(hint).toBeTruthy()
        expect(hint.providerKey).toBe('gmail')
        expect(hint.warningKey).toContain('gmail.warning')
        expect(resolveMessage('zh', 'providerHints.gmail.warning')).toContain('应用专用密码')
    })

    it('identifies outlook and hotmail and points to the oauth requirement warning', () => {
        const hint = getProviderContextHint('user@outlook.com')
        expect(hint).toBeTruthy()
        expect(hint.providerKey).toBe('outlook')
        expect(hint.warningKey).toContain('outlook.warning')
    })

    it('returns null for unlisted or custom domains', () => {
        expect(getProviderContextHint('user@example.com')).toBeNull()
        expect(getProviderContextHint('user@custom-corp.org')).toBeNull()
        expect(getProviderContextHint('')).toBeNull()
        expect(getProviderContextHint(null)).toBeNull()
    })

    it('points every hint at a providerHints entry that resolves in every locale', () => {
        for (const hint of PROVIDER_CONTEXT_HINTS) {
            for (const locale of SUPPORTED_LOCALES) {
                expect(resolveMessage(locale, `providerHints.${hint.badgeKey}`), `${locale} ${hint.badgeKey}`).toBeTypeOf('string')
                expect(resolveMessage(locale, `providerHints.${hint.warningKey}`), `${locale} ${hint.warningKey}`).toBeTypeOf('string')
            }
        }
    })
})
