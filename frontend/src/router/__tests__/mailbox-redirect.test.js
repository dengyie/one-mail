import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { LOCALE_PATH_PATTERN } from '../../i18n/utils'

const router = readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf8')
const sendMail = readFileSync(fileURLToPath(new URL('../../views/index/SendMail.vue', import.meta.url)), 'utf8')
const sendBox = readFileSync(fileURLToPath(new URL('../../views/index/SendBoxPage.vue', import.meta.url)), 'utf8')
const addressManagement = readFileSync(fileURLToPath(new URL('../../views/user/AddressManagement.vue', import.meta.url)), 'utf8')
const admin = readFileSync(fileURLToPath(new URL('../../views/Admin.vue', import.meta.url)), 'utf8')
const domainMailbox = readFileSync(fileURLToPath(new URL('../../views/DomainMailbox.vue', import.meta.url)), 'utf8')
const sidebar = readFileSync(fileURLToPath(new URL('../../components/layout/AppSidebar.vue', import.meta.url)), 'utf8')

describe('mailbox to unified redirect contracts', () => {
  it('turns /mailbox into a locale-aware redirect to /unified instead of Index', () => {
    expect(router).toContain("path: '/mailbox'")
    expect(router).toContain('resolveMailboxRedirect')
    expect(router).toContain('LOCALE_PATH_PATTERN')
    expect(router).toContain('`/:lang(${LOCALE_PATH_PATTERN})/mailbox`')
    expect(router).toContain("return { name: 'not-found' }")
    expect(router).not.toContain("|| '/unified'")
    expect(router).not.toContain("path: '/unified-inbox'")
    expect(router).toContain("path: '/unified'")
    expect(router).toContain("path: '/domain-mailbox'")
    expect(LOCALE_PATH_PATTERN).toBe('zh|en|es|pt-BR|ja|de')
  })

  it('routes root / to Home adaptive entry and hosts temp-mail on /temp-mail', () => {
    expect(router).toContain("component: Home")
    expect(router).toContain("path: '/temp-mail'")
    expect(sendMail).toContain("getRouterPathWithLang('/temp-mail', locale)")
    expect(sendMail).toContain('前往即时收件箱生成邮箱')
    expect(sendMail).not.toContain("getRouterPathWithLang('/mailbox'")
    expect(addressManagement).toContain('getRouterPathWithLang("/temp-mail", locale.value)')
    expect(addressManagement).not.toContain('getRouterPathWithLang("/mailbox"')
    expect(sidebar).toContain("handleNavigate('/temp-mail')")
    expect(sidebar).toContain('即时收件箱')
    expect(sidebar).toContain('v-if="!hasUserSession"')
    expect(sidebar).toContain("handleNavigate('/unified')")
  })

  it('sends inbox back-links to /unified and leaves /domain-mailbox unredirected', () => {
    expect(admin).toContain("getRouterPathWithLang('/unified', locale)")
    expect(admin).not.toContain("getRouterPathWithLang('/mailbox'")
    expect(domainMailbox).toContain("getRouterPathWithLang('/unified', locale)")
    expect(domainMailbox).not.toContain("getRouterPathWithLang('/mailbox'")
    expect(domainMailbox).toContain("query: { from: '/domain-mailbox' }")
  })
})
