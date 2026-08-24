import { describe, expect, it } from 'vitest'
import { daemonCompletesOnboarding, needsOnboarding } from './onboarding'

describe('needsOnboarding', () => {
  it('recovers a fresh org (only the unplaced built-in preset, daemon offline)', () => {
    expect(needsOnboarding(false, false, false, false, false)).toBe(true)
  })

  it('waits for data and preserves initialized orgs', () => {
    expect(needsOnboarding(true, false, false, false, false)).toBe(false)
    // a placed/configured agent means the org is set up (the built-in preset alone does not)
    expect(needsOnboarding(false, false, true, false, false)).toBe(false)
    expect(needsOnboarding(false, false, false, true, false)).toBe(false)
  })

  it('skips the wizard when any of the caller orgs already has a daemon', () => {
    expect(needsOnboarding(false, false, false, false, true)).toBe(false)
  })

  it('keeps a fresh org initialized during a planned daemon relaunch', () => {
    const restarting = { daemonId: 'edge-1', status: 'offline' as const, lifecycleStatus: 'restarting' as const }
    expect(daemonCompletesOnboarding(restarting)).toBe(true)
    expect(needsOnboarding(false, false, false, daemonCompletesOnboarding(restarting), false)).toBe(false)
  })
})
