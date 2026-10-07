import { describe, expect, it } from 'vitest'
import { extractSubjectCode } from '../subject-code'

describe('subject verification codes', () => {
  it('does not turn ordinary English words into copyable codes', () => {
    expect(extractSubjectCode('Your deployment is ready')).toBe('')
    expect(extractSubjectCode('Your account is active')).toBe('')
    expect(extractSubjectCode('Everything is secure')).toBe('')
  })
  it('keeps split, numeric and alphanumeric verification codes', () => {
    expect(extractSubjectCode('你的登录验证码是 482 916')).toBe('482916')
    expect(extractSubjectCode('Your verification code is 1234')).toBe('1234')
    expect(extractSubjectCode('Verification code: AB12CD')).toBe('AB12CD')
    expect(extractSubjectCode('G-123456 is your verification code')).toBe('G-123456')
  })
  it('does not extract years, phone numbers or order identifiers', () => {
    expect(extractSubjectCode('Copyright 2026')).toBe('')
    expect(extractSubjectCode('Your order #123456 has shipped')).toBe('')
    expect(extractSubjectCode('OTP contact number 123-456-7890')).toBe('')
  })
})
