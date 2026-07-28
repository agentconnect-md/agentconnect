import { describe, expect, it } from 'vitest'
import { needsOnboarding } from './onboarding'

describe('needsOnboarding', () => {
  it('recovers an empty org whose only daemon is offline', () => {
    expect(needsOnboarding(false, false, 0, false)).toBe(true)
  })

  it('waits for data and preserves initialized orgs', () => {
    expect(needsOnboarding(true, false, 0, false)).toBe(false)
    expect(needsOnboarding(false, false, 1, false)).toBe(false)
    expect(needsOnboarding(false, false, 0, true)).toBe(false)
  })
})
