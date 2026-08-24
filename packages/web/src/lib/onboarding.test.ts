import { describe, expect, it } from 'vitest'
import { daemonCompletesOnboarding, firstReconnectableDaemonId, needsOnboarding } from './onboarding'
import { localDaemons } from './data'
import type { DaemonRow } from './data'

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
    expect(firstReconnectableDaemonId([restarting])).toBeUndefined()
    expect(needsOnboarding(false, false, false, daemonCompletesOnboarding(restarting), false)).toBe(false)
  })
})

// The redirect, the checklist and the connect step all ask "does this org have a daemon?" —
// an install-wide pool Pod is never the answer, so they share this projection.
describe('localDaemons', () => {
  it('drops pool member Pods and keeps the org own machines', () => {
    const rows = [
      { daemonId: 'pool-1', status: 'online', pool: true },
      { daemonId: 'edge-1', status: 'online', pool: false },
      { daemonId: 'edge-2', status: 'offline' } // older CP: no `pool` field at all
    ] as DaemonRow[]
    expect(localDaemons(rows).map((d) => d.daemonId)).toEqual(['edge-1', 'edge-2'])
    // a pool-only fleet reads as daemon-less, so onboarding still runs
    expect(localDaemons(rows.slice(0, 1)).some(daemonCompletesOnboarding)).toBe(false)
  })
})
