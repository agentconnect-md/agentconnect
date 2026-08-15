/**
 * `PlacementResolver.contentFailoverDaemon` — the one question whose answer is NOT "who serves
 * this agent" (unit, no I/O).
 *
 * Session transcripts and tool bodies are written where the turn ran, so failover is sound only
 * where the store is shared AND this session was written to it. Two facts, one on the session
 * (`contentSetId`) and one on the agent (its current set), and they must be the same set. The
 * resolver is where that is decided, so the routes proxying content never read a placement kind.
 */
import { describe, it, expect } from 'vitest'
import { PlacementResolver, type ResolvableAgent } from './placementResolver.js'
import { AgentId, type DaemonId } from '../domain/ids.js'
import { systemClock } from '../domain/clock.js'

const HOLDER = 'ddddddd1-dddd-4ddd-8ddd-dddddddddddd' as DaemonId
const MACHINE = 'ddddddd2-dddd-4ddd-8ddd-dddddddddddd' as DaemonId
const SET = 'set-1'
const OTHER_SET = 'set-2'

const setAgent: ResolvableAgent = { id: AgentId('a1'), placementKind: 'set', daemonId: null, setId: SET }
const machineAgent: ResolvableAgent = { id: AgentId('a2'), placementKind: 'daemon', daemonId: MACHINE, setId: null }
const unplaced: ResolvableAgent = { id: AgentId('a3'), placementKind: 'daemon', daemonId: null, setId: null }

/** A ledger where HOLDER holds every agent's duty — the shape after a pool member claims one. */
const held = new PlacementResolver({
  duties: { holdersOf: async () => [HOLDER], confirmedHoldersOf: async () => [HOLDER] },
  clock: systemClock
})

describe('PlacementResolver.contentFailoverDaemon', () => {
  it('names the duty holder when the session was written to the set the agent is still on', async () => {
    expect(await held.contentFailoverDaemon(setAgent, { contentSetId: SET })).toBe(HOLDER)
  })

  it('names nobody when the session carries no shared-store provenance, set agent or not', async () => {
    // The bug this pins: the agent ran this session on a local daemon and was moved into the pool
    // afterwards. Its placement is a set, but nothing in that set ever held these rows.
    expect(await held.contentFailoverDaemon(setAgent, { contentSetId: null })).toBeNull()
  })

  it('names nobody when the session was written to a DIFFERENT set', async () => {
    expect(await held.contentFailoverDaemon(setAgent, { contentSetId: OTHER_SET })).toBeNull()
  })

  it('names nobody for a machine placement, even while a holder serves the agent', async () => {
    // `servingDaemon` answers here; content must not, or a move would turn a lost transcript into
    // a valid-looking empty page instead of the honest 503.
    expect(await held.servingDaemon(machineAgent)).toBe(MACHINE)
    expect(await held.contentFailoverDaemon(machineAgent, { contentSetId: SET })).toBeNull()
  })

  it('names nobody for an unplaced agent', async () => {
    expect(await held.contentFailoverDaemon(unplaced, { contentSetId: SET })).toBeNull()
  })

  it('names nobody when no member of the recorded store currently holds the agent', async () => {
    const vacant = new PlacementResolver({
      duties: { holdersOf: async () => [], confirmedHoldersOf: async () => [] },
      clock: systemClock
    })
    expect(await vacant.contentFailoverDaemon(setAgent, { contentSetId: SET })).toBeNull()
  })
})
