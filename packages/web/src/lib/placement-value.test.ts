// Placement projection regressions for machine and set targets.
import { describe, it, expect, afterEach } from 'vitest'
import {
  CLUSTER_LABEL,
  POOL_LABEL,
  POOL_PLACEMENT,
  agentCapabilitySource,
  agentDaemonLabel,
  agentPlacementIcon,
  agentPlacementKind,
  effectiveAgentStatus,
  agentIsPlaced,
  groupPlacementValue,
  groupSetIdOf,
  isPoolPlacementKind,
  placementValueOf,
  poolLabel
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
    expect(agentDaemonLabel({ daemon: POOL_PLACEMENT, placementKind: 'set' }, [], [])).toBe(poolLabel())
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

  it('labels a group by its name and everything else by whatever this deployment calls the pool', () => {
    const groups = [{ setId: 'set-lab', name: 'lab' }]
    expect(agentDaemonLabel({ daemon: POOL_PLACEMENT, placementKind: 'set', setId: 'set-lab' }, [], groups)).toBe('lab')
    expect(agentDaemonLabel({ daemon: POOL_PLACEMENT, placementKind: 'set', setId: 'set-pool' }, [], groups)).toBe(
      poolLabel()
    )
    // A group whose name has not loaded yet still reads as a placement, never as a raw set id.
    expect(agentDaemonLabel({ daemon: POOL_PLACEMENT, placementKind: 'set', setId: 'set-lab' }, [], [])).toBe(
      poolLabel()
    )
  })

  it('round-trips the value the picker submits', () => {
    expect(groupSetIdOf(groupPlacementValue('set-lab'))).toBe('set-lab')
  })
})

describe('what the console calls the pool', () => {
  // One name, resolved in one place: a deployment that shows "Kubernetes cluster" on its Infra
  // page and offers "AgentConnect Cloud" in the placement picker has named two things.
  afterEach(() => {
    delete process.env.FEATURE_FLAGS
  })

  it('is the product on a managed install and the operator’s own cluster everywhere else', () => {
    const pool = { daemon: POOL_PLACEMENT, placementKind: 'set' as const }
    expect(poolLabel()).toBe(CLUSTER_LABEL)
    expect(agentDaemonLabel(pool, [], [])).toBe(CLUSTER_LABEL)
    process.env.FEATURE_FLAGS = 'managed'
    expect(poolLabel()).toBe(POOL_LABEL)
    expect(agentDaemonLabel(pool, [], [])).toBe(POOL_LABEL)
  })
})

// The glyph beside a placement is derived from the same pair as its name, so a row can never draw
// a group or the pool as the one machine that happens to answer for it.
describe('agentPlacementKind / agentPlacementIcon', () => {
  const groups = [{ setId: 'set-lab' }]

  afterEach(() => {
    delete process.env.FEATURE_FLAGS
  })

  it('tells a machine, one of the org’s groups, and the pool apart', () => {
    expect(agentPlacementKind({ placementKind: 'daemon', setId: null }, groups)).toBe('daemon')
    expect(agentPlacementKind({ placementKind: 'set', setId: 'set-lab' }, groups)).toBe('group')
    expect(agentPlacementKind({ placementKind: 'set', setId: 'set-pool' }, groups)).toBe('pool')
    expect(agentPlacementKind({ placementKind: 'pool', setId: null }, groups)).toBe('pool')
  })

  it('reads a group as the pool while the group list is still loading — same as the label does', () => {
    expect(agentPlacementKind({ placementKind: 'set', setId: 'set-lab' }, [])).toBe('pool')
  })

  it('draws the pool as this deployment’s own infrastructure', () => {
    const pool = { placementKind: 'set' as const, setId: 'set-pool' }
    expect(agentPlacementIcon(pool, groups)).toBe('boxes')
    process.env.FEATURE_FLAGS = 'managed'
    expect(agentPlacementIcon(pool, groups)).toBe('cloud')
  })

  it('draws a group as a stack and a machine as a server', () => {
    expect(agentPlacementIcon({ placementKind: 'set', setId: 'set-lab' }, groups)).toBe('layers')
    expect(agentPlacementIcon({ placementKind: 'daemon', setId: null }, groups)).toBe('server')
  })
})

// A set placement names no member, so resolving it BY DAEMON ID answers `undefined` — which every
// caller reads as "nothing reported" rather than "not known". That is how a pool agent whose
// runtime needs a login kept looking ready on Home.
describe('agentCapabilitySource', () => {
  const source = (over: Partial<DaemonRow>): DaemonRow =>
    ({ daemonId: 'd', pool: false, memberSetId: null, status: 'online', ...over }) as DaemonRow
  const groups = [{ setId: 'set-lab' }]
  const fleet = [
    source({ daemonId: 'pod-down', pool: true, memberSetId: 'set-pool', status: 'offline' }),
    source({ daemonId: 'pod-up', pool: true, memberSetId: 'set-pool' }),
    source({ daemonId: 'dmn-1' }),
    source({ daemonId: 'lab-down', memberSetId: 'set-lab', status: 'offline' }),
    source({ daemonId: 'lab-up', memberSetId: 'set-lab' })
  ]

  it('resolves a machine placement to that machine', () => {
    expect(agentCapabilitySource({ daemon: 'dmn-1', placementKind: 'daemon' }, fleet, groups)?.daemonId).toBe('dmn-1')
    expect(agentCapabilitySource({ daemon: 'gone', placementKind: 'daemon' }, fleet, groups)).toBeUndefined()
  })

  it('resolves the pool and a group to a SERVING member, never to the placement', () => {
    const pool = { daemon: POOL_PLACEMENT, placementKind: 'set' as const, setId: 'set-pool' }
    expect(agentCapabilitySource(pool, fleet, groups)?.daemonId).toBe('pod-up')
    const group = { daemon: POOL_PLACEMENT, placementKind: 'set' as const, setId: 'set-lab' }
    expect(agentCapabilitySource(group, fleet, groups)?.daemonId).toBe('lab-up')
  })

  it('falls back to an offline member rather than to nothing — a stale catalog still reports', () => {
    const offlinePool = [fleet[0]!]
    const pool = { daemon: POOL_PLACEMENT, placementKind: 'set' as const, setId: 'set-pool' }
    expect(agentCapabilitySource(pool, offlinePool, groups)?.daemonId).toBe('pod-down')
  })

  it('never hands a group placement a pool member, nor the pool a group member', () => {
    const group = { daemon: POOL_PLACEMENT, placementKind: 'set' as const, setId: 'set-lab' }
    expect(agentCapabilitySource(group, [fleet[1]!], groups)).toBeUndefined()
    const pool = { daemon: POOL_PLACEMENT, placementKind: 'set' as const, setId: 'set-pool' }
    expect(agentCapabilitySource(pool, [fleet[4]!], groups)).toBeUndefined()
  })
})
