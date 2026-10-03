import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SUPPORTED_LOCALES } from '../../i18n/locale-registry'

const conf = readFileSync(
  fileURLToPath(new URL('../../../../deploy/nginx/one-mail-frontend.conf', import.meta.url)),
  'utf8',
)

describe('pxed nginx mailbox 301 contract', () => {
  it('keeps a relative 301 that matches every supported locale and not domain-mailbox', () => {
    expect(conf).toContain('absolute_redirect off')
    expect(conf).toContain('return 301 /$1unified$is_args$args')
    expect(conf).toContain('location ~ ^/((?:zh|en|es|pt-BR|ja|de)/)?mailbox/?$')
    expect(conf).not.toContain('$http_host')
    expect(conf).not.toContain('$scheme')
    expect(conf).not.toContain('https://inbox.mangoqwq.com')
    expect(conf).not.toMatch(/location[^\n]*domain-mailbox/)

    for (const locale of SUPPORTED_LOCALES) {
      expect(conf).toContain(locale)
    }
  })
})
