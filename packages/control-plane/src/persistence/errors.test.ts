import { describe, it, expect } from 'vitest'
import { OrgCreationLimitReached } from './errors.js'

describe('OrgCreationLimitReached', () => {
  it('states the ceiling without naming the accounts that are exempt', () => {
    for (const limit of [0, 1, 2]) {
      expect(new OrgCreationLimitReached(limit).message).not.toMatch(/admin/i)
    }
  })

  it('agrees in number with the ceiling', () => {
    expect(new OrgCreationLimitReached(1).message).toBe('this account has reached its limit of 1 organization')
    expect(new OrgCreationLimitReached(2).message).toBe('this account has reached its limit of 2 organizations')
    expect(new OrgCreationLimitReached(0).message).toBe("organization creation isn't available for this account")
  })
})
