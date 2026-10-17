import { describe, expect, it } from 'vitest'
import { withCountQuery } from '../index'

describe('withCountQuery', () => {
  it('emits nothing by default so legacy endpoints keep their default-on counting', () => {
    expect(withCountQuery(undefined)).toBe('')
    expect(withCountQuery({})).toBe('')
    expect(withCountQuery({ withCount: true })).toBe('')
  })

  it('emits &with_count=0 only for an explicit opt-out (background polling)', () => {
    expect(withCountQuery({ withCount: false })).toBe('&with_count=0')
  })
})