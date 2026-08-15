// The console's ONE mapping from a DTO's placement pair to the value it selects on.
//
// A pool placement carries `daemonId: null` by design — no member id survives a rollout — so
// anything that derives "is this the pool?" from `daemonId` being non-null reads a pool agent as
// unplaced. That is what made a reloaded agent lose its Cloud selection: the list projection went
// through the mapping and the editor's own re-fetch did not.
import { describe, it, expect } from 'vitest'
import { CLOUD_PLACEMENT, effectiveAgentStatus, agentIsPlaced, placementValueOf } from '@/lib/data'
import type { Agent, DaemonRow } from '@/lib/data'

const poolAgent = (over: Partial<Agent> = {}): Pick<Agent, 'status' | 'daemon' | 'placementKind' | 'placementReady'> =>
  ({
    status: 'online',
    daemon: CLOUD_PLACEMENT,
    placementKind: 'pool',
    placementReady: true,
    ...over
  }) as Pick<Agent, 'status' | 'daemon' | 'placementKind' | 'placementReady'>

describe('placementValueOf', () => {
  it('maps a pool placement to the pool sentinel, never to its null member id', () => {
    expect(placementValueOf({ placementKind: 'pool', daemonId: null })).toBe(CLOUD_PLACEMENT)
  })

  it('ignores a stray member id under a pool kind — the KIND is what says pool', () => {
    expect(placementValueOf({ placementKind: 'pool', daemonId: 'dmn_1' })).toBe(CLOUD_PLACEMENT)
  })

  // What the CP actually STORES and emits now: the pool is one member set (daemon-groups.md §2).
  // `pool` stays accepted on the way in as API sugar, so both spellings have to read as Cloud.
  it('maps a set placement to the same Cloud sentinel — that is the console round-trip', () => {
    expect(placementValueOf({ placementKind: 'set', daemonId: null })).toBe(CLOUD_PLACEMENT)
    expect(agentIsPlaced({ daemon: CLOUD_PLACEMENT, runtime: 'claude', placementKind: 'set' })).toBe(true)
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
    expect(agentIsPlaced({ daemon: CLOUD_PLACEMENT, runtime: 'claude', placementKind: 'pool' })).toBe(true)
  })
})
