import { describe, expect, it } from 'vitest'
import { resolveMailboxRedirect } from '../utils'

describe('resolveMailboxRedirect', () => {
  it('maps default-locale /mailbox to /unified and keeps query plus hash', () => {
    expect(resolveMailboxRedirect('/mailbox')).toBe('/unified')
    expect(resolveMailboxRedirect('/mailbox/')).toBe('/unified')
    expect(resolveMailboxRedirect('/mailbox?foo=1#mail')).toBe('/unified?foo=1#mail')
    expect(resolveMailboxRedirect('/zh/mailbox?jwt=abc')).toBe('/unified?jwt=abc')
  })

  it('keeps non-default locale prefixes including pt-BR', () => {
    expect(resolveMailboxRedirect('/en/mailbox')).toBe('/en/unified')
    expect(resolveMailboxRedirect('/en/mailbox/?x=1#h')).toBe('/en/unified?x=1#h')
    expect(resolveMailboxRedirect('/es/mailbox')).toBe('/es/unified')
    expect(resolveMailboxRedirect('/ja/mailbox')).toBe('/ja/unified')
    expect(resolveMailboxRedirect('/de/mailbox')).toBe('/de/unified')
    expect(resolveMailboxRedirect('/pt-BR/mailbox?tab=list')).toBe('/pt-BR/unified?tab=list')
  })

  it('ignores non-mailbox paths so temp mail and domain workbench stay put', () => {
    expect(resolveMailboxRedirect('/')).toBeNull()
    expect(resolveMailboxRedirect('/unified')).toBeNull()
    expect(resolveMailboxRedirect('/domain-mailbox')).toBeNull()
    expect(resolveMailboxRedirect('/mailbox/extra')).toBeNull()
    expect(resolveMailboxRedirect('/en/sendmail')).toBeNull()
    expect(resolveMailboxRedirect('/unified-inbox')).toBeNull()
  })

  it('does not treat unsupported locale prefixes as mailbox', () => {
    expect(resolveMailboxRedirect('/fr/mailbox')).toBeNull()
    expect(resolveMailboxRedirect('/foo/mailbox')).toBeNull()
    expect(resolveMailboxRedirect('/en-US/mailbox')).toBeNull()
  })
})
