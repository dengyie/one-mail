import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const view = readFileSync(fileURLToPath(new URL('../index/SendMail.vue', import.meta.url)), 'utf8')

describe('send mail external-account identity', () => {
  it('fetches can_send external accounts and builds the identity dropdown', () => {
    expect(view).toContain('api.userMailAccounts.list()')
    expect(view).toContain('account.enabled && account.can_send')
    expect(view).toContain("const identityOptions = computed(() => [")
    expect(view).toContain("{ label: settings.value.address, value: 'default' }")
    expect(view).toContain('value: account.id')
  })

  it('keeps the native /api/send_mail path for the default identity', () => {
    expect(view).toContain("await api.fetch(`/api/send_mail`, {")
    expect(view).toContain("'x-idempotency-key': currentSendMailIdempotencyKey()")
    expect(view).toContain("'x-one-mail-client': 'web'")
  })

  it('routes external identities to POST /api/send_mail/external with the account payload', () => {
    expect(view).toContain("await api.fetch(`/api/send_mail/external`, {")
    expect(view).toContain('account_id: externalAccount.id')
    expect(view).toContain('from_addr: externalAccount.username')
    expect(view).toContain('is_html: isHtml')
  })

  it('derives the disabled from-address from the selected external account', () => {
    expect(view).toContain('selectedExternalAccount?.username || settings.address')
    expect(view).toContain("const selectedExternalAccount = computed(() =>")
  })
})
