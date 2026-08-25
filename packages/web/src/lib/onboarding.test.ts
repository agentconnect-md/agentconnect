import { describe, expect, it } from 'vitest'
import { daemonCompletesOnboarding, firstReconnectableDaemonId, needsOnboarding } from './onboarding'
import { localDaemons } from './data'
import type { DaemonRow } from './data'

describe('needsOnboarding', () => {
  it('sends an owner of a not-yet-onboarded org to the wizard', () => {
    expect(needsOnboarding({ role: 'owner', onboardingCompleted: false })).toBe(true)
  })

  it('never redirects once the org is marked onboarded (finish OR skip)', () => {
    expect(needsOnboarding({ role: 'owner', onboardingCompleted: true })).toBe(false)
  })

  it('treats an org that already runs a daemon as set up, whatever the flag says', () => {
    expect(needsOnboarding({ role: 'owner', onboardingCompleted: false, daemonCount: 2 })).toBe(false)
    expect(needsOnboarding({ role: 'owner', onboardingCompleted: false, daemonCount: 0 })).toBe(true)
  })

  it('is owner-only: collaborators and viewers never onboard', () => {
    expect(needsOnboarding({ role: 'collaborator', onboardingCompleted: false })).toBe(false)
    expect(needsOnboarding({ role: 'viewer', onboardingCompleted: false })).toBe(false)
  })

  it('treats an unresolved org or an older CP (field absent) as onboarded', () => {
    expect(needsOnboarding(null)).toBe(false)
    expect(needsOnboarding({ role: 'owner' })).toBe(false)
  })
})

// The daemon connect step asks "does this org have a daemon?" — an install-wide pool
// Pod is never the answer, so it shares this projection.
describe('localDaemons', () => {
  it('drops pool member Pods and keeps the org own machines', () => {
    const rows = [
      { daemonId: 'pool-1', status: 'online', pool: true },
      { daemonId: 'edge-1', status: 'online', pool: false },
      { daemonId: 'edge-2', status: 'offline' } // older CP: no `pool` field at all
    ] as DaemonRow[]
    expect(localDaemons(rows).map((d) => d.daemonId)).toEqual(['edge-1', 'edge-2'])
    expect(localDaemons(rows.slice(0, 1)).some(daemonCompletesOnboarding)).toBe(false)
  })

  it('keeps a daemon established during a planned relaunch', () => {
    const restarting = { daemonId: 'edge-1', status: 'offline' as const, lifecycleStatus: 'restarting' as const }
    expect(daemonCompletesOnboarding(restarting)).toBe(true)
    expect(firstReconnectableDaemonId([restarting])).toBeUndefined()
  })
})
