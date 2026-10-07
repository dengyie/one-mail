import { describe, expect, it } from 'vitest'
import { splitPathSuffix, replaceLocaleInFullPath } from '../utils'

describe('splitPathSuffix', () => {
    it('leaves a bare path untouched', () => {
        expect(splitPathSuffix('/user/external-accounts')).toEqual({ path: '/user/external-accounts', suffix: '' })
    })

    it('cuts query and hash off in either order', () => {
        expect(splitPathSuffix('/user/settings?tab=mail')).toEqual({ path: '/user/settings', suffix: '?tab=mail' })
        expect(splitPathSuffix('/user/settings#anchor')).toEqual({ path: '/user/settings', suffix: '#anchor' })
        expect(splitPathSuffix('/user/settings#anchor?x=1')).toEqual({ path: '/user/settings', suffix: '#anchor?x=1' })
        expect(splitPathSuffix('/user/settings?tab=mail#anchor')).toEqual({ path: '/user/settings', suffix: '?tab=mail#anchor' })
    })

    it('treats an empty path as root rather than throwing', () => {
        expect(splitPathSuffix('')).toEqual({ path: '/', suffix: '' })
    })

    it('feeds replaceLocaleInFullPath so locale swaps keep query and hash', () => {
        expect(replaceLocaleInFullPath('/en/user/settings?tab=mail#a', 'zh')).toBe('/user/settings?tab=mail#a')
    })
})