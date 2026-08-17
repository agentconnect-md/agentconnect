// Placement projection regressions for machine and set targets.
import { describe, it, expect } from 'vitest'
import {
  POOL_LABEL,
  POOL_PLACEMENT,
  agentDaemonLabel,
  effectiveAgentStatus,
  agentIsPlaced,
  groupPlacementValue,
  groupSetIdOf,
  isPoolPlacementKind,
  placementValueOf
} from '@/lib/data'
import type { Agent, DaemonRow } from '@/lib/data'

const poolAgent = (over: Partial<Agent> = {}): Pick<Agent, 'status' | 'daemon' | 'placementKind' | 'placementReady'> =>
  ({
    status: 'online',
    daemon: POOL_PLACEMENT,
    placementKind: 'pool',
    placementReady: true,
    ...over
  }) as Pick<Agent, 'status' | 'daemon' | 'placementKind' | 'placementReady'>

describe('placementValueOf', () => {
  it('maps a pool placement to the pool sentinel, never to its null member id', () => {
    expect(placementValueOf({ placementKind: 'pool', daemonId: null })).toBe(POOL_PLACEMENT)
  })

  it('ignores a stray member id under a pool kind — the KIND is what says pool', () => {
    expect(placementValueOf({ placementKind: 'pool', daemonId: 'dmn_1' })).toBe(POOL_PLACEMENT)
  })

  // What the CP actually STORES and emits now: the pool is one member set (daemon-groups.md §2).
  // `pool` stays accepted on the way in as API sugar, so both spellings have to read as Cloud.
  it('maps a set placement to the same Cloud sentinel — that is the console round-trip', () => {
    expect(placementValueOf({ placementKind: 'set', daemonId: null })).toBe(POOL_PLACEMENT)
    expect(agentIsPlaced({ daemon: POOL_PLACEMENT, runtime: 'claude', placementKind: 'set' })).toBe(true)
    expect(effectiveAgentStatus(poolAgent({ placementKind: 'set' }), undefined)).toBe('online')
    expect(effectiveAgentStatus(poolAgent({ placementKind: 'set', placementReady: false }), undefined)).toBe('offline')
  })

  it('maps a machine placement to its member id, and an unplaced agent to null', () => {
    expect(placementValueOf({ placementKind: 'daemon', daemonId: 'dmn_1' })).toBe('dmn_1')
    expect(placementValueOf({ placementKind: 'daemon', daemonId: null })).toBeNull()
    // An older CP omits the field entirely; that has to keep meaning `daemon`.
    expect(placementValueOf({ daemonId: 'dmn_1' })).toBe('dmn_1')
  })
})

describe('agentDaemonLabel', () => {
  it('uses the Agent projection outside the visible fleet and never falls back to a raw daemon id', () => {
    const daemonId = 'd8e6ea1f-c9bb-4d7b-8b75-e4db14e84999'
    expect(agentDaemonLabel({ daemon: daemonId, daemonName: 'Daemon A', placementKind: 'daemon' }, [], [])).toBe(
      'Daemon A'
    )
    expect(
      agentDaemonLabel(
        { daemon: daemonId, daemonName: 'Old name', placementKind: 'daemon' },
        [{ daemonId, name: 'Renamed daemon' }],
        []
      )
    ).toBe('Renamed daemon')
    expect(agentDaemonLabel({ daemon: daemonId, placementKind: 'daemon' }, [], [])).toBe('—')
    expect(agentDaemonLabel({ daemon: POOL_PLACEMENT, placementKind: 'set' }, [], [])).toBe(POOL_LABEL)
  })
})

describe('a pool agent’s readiness is the server’s answer, not a member’s liveness', () => {
  it('stays online while the pool is ready, with no owning daemon to consult', () => {
    // #987: asking a placed member's liveness is what kept a rolled-over agent permanently
    // offline — the member it named was gone by construction.
    expect(effectiveAgentStatus(poolAgent(), undefined)).toBe('online')
  })

  it('reads offline when no member can serve it', () => {
    expect(effectiveAgentStatus(poolAgent({ placementReady: false }), undefined)).toBe('offline')
  })

  it('does not consult an unrelated daemon row’s liveness', () => {
    const dead = { status: 'offline', lifecycleStatus: undefined } as unknown as Pick<
      DaemonRow,
      'status' | 'lifecycleStatus'
    >
    expect(effectiveAgentStatus(poolAgent(), dead)).toBe('online')
  })

  it('counts as placed even though it names no machine', () => {
    expect(agentIsPlaced({ daemon: POOL_PLACEMENT, runtime: 'claude', placementKind: 'pool' })).toBe(true)
  })
})

// Once an org can own groups, `set` no longer means Cloud: the pool is the set the ORG DOES NOT
// OWN, so telling them apart needs the org's own list and nothing else (daemon-groups.md §2).
describe('placementValueOf with the org’s own groups', () => {
  const orgSets = new Set(['set-lab'])

  it('maps one of the org’s sets to its group value, not to the Cloud sentinel', () => {
    expect(placementValueOf({ placementKind: 'set', daemonId: null, setId: 'set-lab' }, orgSets)).toBe('set:set-lab')
    expect(groupSetIdOf('set:set-lab')).toBe('set-lab')
  })

  it('maps a set the org does not own — the pool — to Cloud', () => {
    expect(placementValueOf({ placementKind: 'set', daemonId: null, setId: 'set-pool' }, orgSets)).toBe(POOL_PLACEMENT)
    expect(isPoolPlacementKind('set', 'set-pool', orgSets)).toBe(true)
    expect(isPoolPlacementKind('set', 'set-lab', orgSets)).toBe(false)
  })

  it('reads a set placement as Cloud while the group list is still loading', () => {
    // The pre-groups behavior, which is what EVERY set placement was: a wrong label for a moment
    // beats inventing a group that may not exist.
    expect(placementValueOf({ placementKind: 'set', daemonId: null, setId: 'set-lab' })).toBe(POOL_PLACEMENT)
  })

  it('leaves a machine placement and an unplaced agent alone', () => {
    expect(placementValueOf({ placementKind: 'daemon', daemonId: 'dmn_1', setId: null }, orgSets)).toBe('dmn_1')
    expect(placementValueOf({ placementKind: 'daemon', daemonId: null, setId: null }, orgSets)).toBeNull()
    expect(groupSetIdOf('dmn_1')).toBeNull()
    expect(groupSetIdOf(null)).toBeNull()
  })

  it('labels a group by its name and everything else the pool by Cloud', () => {
    const groups = [{ setId: 'set-lab', name: 'lab' }]
    expect(agentDaemonLabel({ daemon: POOL_PLACEMENT, placementKind: 'set', setId: 'set-lab' }, [], groups)).toBe('lab')
    expect(agentDaemonLabel({ daemon: POOL_PLACEMENT, placementKind: 'set', setId: 'set-pool' }, [], groups)).toBe(
      POOL_LABEL
    )
    // A group whose name has not loaded yet still reads as a placement, never as a raw set id.
    expect(agentDaemonLabel({ daemon: POOL_PLACEMENT, placementKind: 'set', setId: 'set-lab' }, [], [])).toBe(
      POOL_LABEL
    )
  })

  it('round-trips the value the picker submits', () => {
    expect(groupSetIdOf(groupPlacementValue('set-lab'))).toBe('set-lab')
  })
})
