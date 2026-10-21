// TURN metrics (computer-use.md §7.2): bytes relayed per Computer feed billing (#3230); labels are closed values plus a Computer id.
import { metrics, type Meter } from '@opentelemetry/api'
import type { TurnSubject } from './server.js'

export type TurnAllocationOutcome = 'created' | 'quota' | 'capacity' | 'unauthorized' | 'stale_nonce'
export type TurnEndReason = 'released' | 'expired' | 'credential_expired' | 'idle' | 'client_closed' | 'shutdown'
export type TurnDropReason = 'bandwidth' | 'no_permission' | 'no_peer' | 'backpressure'

export interface TurnMetrics {
  allocation(outcome: TurnAllocationOutcome): void
  ended(reason: TurnEndReason, transport: string): void
  /** One datagram handed from one allocation to another. */
  relayed(bytes: number, from: TurnSubject, to: TurnSubject): void
  dropped(bytes: number, reason: TurnDropReason): void
  observeActive(read: () => number): void
}

export const noTurnMetrics: TurnMetrics = {
  allocation: () => {},
  ended: () => {},
  relayed: () => {},
  dropped: () => {},
  observeActive: () => {}
}

export function createTurnMetrics(
  meter: Pick<Meter, 'createCounter' | 'createObservableGauge'> = metrics.getMeter('agentconnect-relay')
): TurnMetrics {
  const allocations = meter.createCounter('agentconnect.relay.turn.allocations', {
    description: 'TURN Allocate requests by outcome'
  })
  const ended = meter.createCounter('agentconnect.relay.turn.allocations_ended', {
    description: 'TURN allocations that ended, by reason and client transport'
  })
  const relayed = meter.createCounter('agentconnect.relay.turn.relayed_bytes', {
    description: 'Media bytes relayed between allocations, by the Computer on either end',
    unit: 'By'
  })
  const dropped = meter.createCounter('agentconnect.relay.turn.dropped_bytes', {
    description: 'Bytes the TURN server dropped, by reason',
    unit: 'By'
  })
  const active = meter.createObservableGauge('agentconnect.relay.turn.active_allocations', {
    description: 'TURN allocations this relay holds'
  })
  return {
    allocation: (outcome) => allocations.add(1, { outcome }),
    ended: (reason, transport) => ended.add(1, { reason, transport }),
    relayed: (bytes, from, to) => {
      const computer = from.kind === 'computer' ? from : to.kind === 'computer' ? to : undefined
      relayed.add(bytes, {
        direction: from.kind === 'computer' ? 'from_computer' : to.kind === 'computer' ? 'to_computer' : 'other',
        ...(computer?.computerId ? { 'computer.id': computer.computerId } : {})
      })
    },
    dropped: (bytes, reason) => dropped.add(bytes, { reason }),
    observeActive: (read) => active.addCallback((result) => result.observe(read()))
  }
}
