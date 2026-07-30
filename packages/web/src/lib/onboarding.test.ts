import { describe, expect, it } from 'vitest'
import { daemonCompletesOnboarding, firstReconnectableDaemonId, needsOnboarding } from './onboarding'

describe('needsOnboarding', () => {
  it('recovers an empty org whose only daemon is offline', () => {
    expect(needsOnboarding(false, false, 0, false)).toBe(true)
  })

  it('waits for data and preserves initialized orgs', () => {
    expect(needsOnboarding(true, false, 0, false)).toBe(false)
    expect(needsOnboarding(false, false, 1, false)).toBe(false)
    expect(needsOnboarding(false, false, 0, true)).toBe(false)
  })

  it('keeps an empty org initialized during a planned daemon relaunch', () => {
    const restarting = { daemonId: 'edge-1', status: 'offline' as const, lifecycleStatus: 'restarting' as const }
    expect(daemonCompletesOnboarding(restarting)).toBe(true)
    expect(firstReconnectableDaemonId([restarting])).toBeUndefined()
    expect(needsOnboarding(false, false, 0, daemonCompletesOnboarding(restarting))).toBe(false)
  })
})
