/**
 * Guards the invariants this app depends on but cannot see at runtime.
 *
 * `createI18n` runs with `fallbackLocale: 'zh'` and both `missingWarn` and
 * `fallbackWarn` disabled, so a key that exists for the source locales but is
 * missing from an additional locale renders Chinese silently instead of
 * failing. The source locale ('zh') is the reference: every supported locale
 * must ship exactly the same leaf keys.
 *
 * Key-presence alone is not enough: a slot left empty or a value that drops a
 * `{placeholder}` renders a broken string while all "key parity" checks pass.
 * So each locale must also have non-empty values and the same placeholder set
 * as the source locale for every key.
 *
 * The CJK check is a heuristic for "a translation slot still holds Chinese
 * copy". Japanese legitimately uses CJK ideographs, so it is excluded; the
 * guarded set is derived from the locale registry so a newly added locale is
 * guarded automatically instead of being silently skipped.
 */
import { describe, expect, it } from 'vitest'
import { I18N_MESSAGES } from '../messages'
import { SUPPORTED_LOCALES } from '../locale-registry'

const SOURCE_LOCALE = 'zh'
// 日语合法使用汉字，不参与"残留中文"启发式检查
const CJK_SCRIPT_LOCALES = ['ja']
const CJK_GUARDED_LOCALES = SUPPORTED_LOCALES.filter(
  (locale) => locale !== SOURCE_LOCALE && !CJK_SCRIPT_LOCALES.includes(locale),
)

const collectLeaves = (node, prefix = '') => {
  const leaves = []
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') leaves.push(path)
    else leaves.push(...collectLeaves(value, path))
  }
  return leaves
}

const leafValue = (tree, path) => path.split('.').reduce((node, segment) => node?.[segment], tree)

const placeholderTokens = (value) =>
  [...String(value).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort()

const sourceLeaves = collectLeaves(I18N_MESSAGES[SOURCE_LOCALE])
const sourceLeafSet = new Set(sourceLeaves)

describe('locale message parity', () => {
  it('builds a message tree for every supported locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(I18N_MESSAGES[locale], `no message tree for ${locale}`).toBeTruthy()
    }
  })

  it.each(SUPPORTED_LOCALES)('ships every %s key present in the source locale', (locale) => {
    const leaves = new Set(collectLeaves(I18N_MESSAGES[locale]))
    const missing = sourceLeaves.filter((key) => !leaves.has(key))
    expect(missing, `${locale} is missing ${missing.length} key(s)`).toEqual([])
  })

  it.each(SUPPORTED_LOCALES)('defines no %s key absent from the source locale', (locale) => {
    const extra = collectLeaves(I18N_MESSAGES[locale]).filter((key) => !sourceLeafSet.has(key))
    expect(extra, `${locale} defines ${extra.length} key(s) unknown to ${SOURCE_LOCALE}`).toEqual([])
  })

  it.each(SUPPORTED_LOCALES)('has no empty %s message slot', (locale) => {
    const empties = collectLeaves(I18N_MESSAGES[locale]).filter(
      (key) => leafValue(I18N_MESSAGES[locale], key) === '',
    )
    expect(empties, `${locale} has ${empties.length} empty message(s)`).toEqual([])
  })

  it.each(SUPPORTED_LOCALES)('keeps %s placeholder sets aligned with the source locale', (locale) => {
    const mismatches = sourceLeaves
      .filter((key) => {
        const sourceTokens = placeholderTokens(leafValue(I18N_MESSAGES[SOURCE_LOCALE], key))
        const localeTokens = placeholderTokens(leafValue(I18N_MESSAGES[locale], key))
        return JSON.stringify(sourceTokens) !== JSON.stringify(localeTokens)
      })
      .map((key) => {
        const sourceTokens = placeholderTokens(leafValue(I18N_MESSAGES[SOURCE_LOCALE], key))
        const localeTokens = placeholderTokens(leafValue(I18N_MESSAGES[locale], key))
        return `${key}: source ${sourceTokens} vs ${localeTokens}`
      })
    expect(mismatches, `${locale} has ${mismatches.length} placeholder mismatch(es)`).toEqual([])
  })

  it.each(CJK_GUARDED_LOCALES)('has no untranslated CJK value in %s', (locale) => {
    const offenders = []
    const walk = (node, prefix = '') => {
      for (const [key, value] of Object.entries(node)) {
        const path = prefix ? `${prefix}.${key}` : key
        if (typeof value === 'string') {
          if (/[\u4e00-\u9fff]/.test(value)) offenders.push(`${path} = ${value}`)
        } else {
          walk(value, path)
        }
      }
    }
    walk(I18N_MESSAGES[locale])
    expect(offenders, `${locale} still contains Chinese copy`).toEqual([])
  })
})
