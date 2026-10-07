import { describe, expect, it } from 'vitest'
import { getProviderContextHint, PROVIDER_CONTEXT_HINTS } from '../onboarding_hints.js'

describe('onboarding provider hints contract', () => {
    it('accurately identifies linux.do and warns about empty authorized IP', () => {
        const hint = getProviderContextHint('mangoqwq@linux.do')
        expect(hint).toBeTruthy()
        expect(hint.providerKey).toBe('linux_do')
        expect(hint.badge).toContain('LINUX DO')
        expect(hint.warningText).toContain('授权IP')
        expect(hint.warningText).toContain('留空')
    })

    it('identifies qq and foxmail addresses', () => {
        const qqHint = getProviderContextHint('user@qq.com')
        expect(qqHint).toBeTruthy()
        expect(qqHint.providerKey).toBe('qq')
        expect(qqHint.warningText).toContain('授权码')

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

    it('identifies google gmail and warns for app password', () => {
        const hint = getProviderContextHint('user@gmail.com')
        expect(hint).toBeTruthy()
        expect(hint.providerKey).toBe('gmail')
        expect(hint.warningText).toContain('应用专用密码')
    })

    it('identifies outlook and hotmail and warns about oauth requirement', () => {
        const hint = getProviderContextHint('user@outlook.com')
        expect(hint).toBeTruthy()
        expect(hint.providerKey).toBe('outlook')
        expect(hint.warningText).toContain('OAuth2')
    })

    it('returns null for unlisted or custom domains', () => {
        expect(getProviderContextHint('user@example.com')).toBeNull()
        expect(getProviderContextHint('user@custom-corp.org')).toBeNull()
        expect(getProviderContextHint('')).toBeNull()
        expect(getProviderContextHint(null)).toBeNull()
    })
})
