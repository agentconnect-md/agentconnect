/**
 * `PlacementResolver.contentFailoverDaemon` — the one question whose answer is NOT "who serves
 * this agent" (unit, no I/O).
 *
 * Session transcripts and tool bodies are written where the turn ran. A member set shares one
 * data-plane store, so a peer can still read a retired member's rows; a machine's store is its
 * own, and a move carries none of it. The resolver is where that difference is decided, so the
 * routes that proxy content never read a placement kind.
 */
import { describe, it, expect } from 'vitest'
import { PlacementResolver, type ResolvableAgent } from './placementResolver.js'
import { AgentId, type DaemonId } from '../domain/ids.js'
import { systemClock } from '../domain/clock.js'

const HOLDER = 'ddddddd1-dddd-4ddd-8ddd-dddddddddddd' as DaemonId
const MACHINE = 'ddddddd2-dddd-4ddd-8ddd-dddddddddddd' as DaemonId

const setAgent: ResolvableAgent = { id: AgentId('a1'), placementKind: 'set', daemonId: null, setId: 'set-1' }
const machineAgent: ResolvableAgent = { id: AgentId('a2'), placementKind: 'daemon', daemonId: MACHINE, setId: null }
const unplaced: ResolvableAgent = { id: AgentId('a3'), placementKind: 'daemon', daemonId: null, setId: null }

/** A ledger where HOLDER holds every agent's duty — the shape after a pool member claims one. */
const held = new PlacementResolver({
  duties: { holdersOf: async () => [HOLDER], confirmedHoldersOf: async () => [HOLDER] },
  clock: systemClock
})

describe('PlacementResolver.contentFailoverDaemon', () => {
  it('names the duty holder for a set placement — its members read one shared store', async () => {
    expect(await held.contentFailoverDaemon(setAgent)).toBe(HOLDER)
  })

  it('names nobody for a machine placement, even while a holder serves the agent', async () => {
    // `servingDaemon` would answer here; content must not, or a move would turn a lost
    // transcript into a valid-looking empty page instead of the honest 503.
    expect(await held.servingDaemon(machineAgent)).toBe(MACHINE)
    expect(await held.contentFailoverDaemon(machineAgent)).toBeNull()
  })

  it('names nobody for an unplaced agent', async () => {
    expect(await held.contentFailoverDaemon(unplaced)).toBeNull()
  })

  it('names nobody for a set placement no member currently holds', async () => {
    const vacant = new PlacementResolver({
      duties: { holdersOf: async () => [], confirmedHoldersOf: async () => [] },
      clock: systemClock
    })
    expect(await vacant.contentFailoverDaemon(setAgent)).toBeNull()
  })
})
