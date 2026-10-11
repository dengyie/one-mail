/**
 * A scoped `useScopedI18n(namespace)` + `t(key)` call resolves
 * `${namespace}.${key}`. When that key is absent, vue-i18n (missingWarn and
 * fallbackWarn disabled) returns the raw dotted path, so a namespace/key
 * mismatch renders "views.admin.SendMail.deliveryUnknown" to the user with no
 * error. locale-parity only checks registry <-> locale files, so it cannot see
 * this class of bug. This test pins the keys the views actually call.
 */
import { describe, expect, it } from 'vitest'
import { I18N_MESSAGES } from '../messages'
import { SUPPORTED_LOCALES } from '../locale-registry'

const leaf = (tree, path) => path.split('.').reduce((node, segment) => node?.[segment], tree)

const SCOPED_KEYS = [
  // admin SendMail renders this on the backend's 503 delivery-unknown branch.
  ['views.admin.SendMail', ['deliveryUnknown']],
  // AiExtractInfo copy button labels.
  ['components.AiExtractInfo', ['copy', 'copied']],
]

describe('scoped translation keys resolve', () => {
  it.each(SUPPORTED_LOCALES)('%s ships every scoped key used by the views', (locale) => {
    for (const [namespace, keys] of SCOPED_KEYS) {
      for (const key of keys) {
        const path = `${namespace}.${key}`
        const value = leaf(I18N_MESSAGES[locale], path)
        expect(typeof value, `${locale} is missing ${path}`).toBe('string')
        expect(value.length, `${locale} has an empty ${path}`).toBeGreaterThan(0)
        expect(value, `${locale} did not resolve ${path}`).not.toBe(path)
      }
    }
  })
})
