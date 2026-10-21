import { describe, expect, it } from 'vitest'
import { createTurnMetrics } from './metrics.js'

describe('createTurnMetrics', () => {
  it('counts relayed bytes against the Computer on either end, and reads active allocations on collection', () => {
    const adds: Array<{ name: string; value: number; attributes: unknown }> = []
    const callbacks: Array<(result: { observe: (value: number) => void }) => void> = []
    const meter = {
      createCounter: (name: string) => ({
        add: (value: number, attributes: unknown) => adds.push({ name, value, attributes })
      }),
      createObservableGauge: () => ({ addCallback: (cb: (typeof callbacks)[number]) => callbacks.push(cb) })
    }
    const metrics = createTurnMetrics(meter as unknown as Parameters<typeof createTurnMetrics>[0])
    metrics.relayed(1200, { kind: 'computer', computerId: 'c1' }, { kind: 'viewer' })
    metrics.relayed(80, { kind: 'viewer' }, { kind: 'computer', computerId: 'c1' })
    metrics.relayed(10, { kind: 'viewer' }, { kind: 'other' })
    metrics.dropped(500, 'bandwidth')
    metrics.allocation('created')
    metrics.ended('idle', 'tls')
    metrics.observeActive(() => 3)
    const observed: number[] = []
    callbacks.forEach((cb) => cb({ observe: (value) => observed.push(value) }))
    expect(adds).toEqual([
      {
        name: 'agentconnect.relay.turn.relayed_bytes',
        value: 1200,
        attributes: { direction: 'from_computer', 'computer.id': 'c1' }
      },
      {
        name: 'agentconnect.relay.turn.relayed_bytes',
        value: 80,
        attributes: { direction: 'to_computer', 'computer.id': 'c1' }
      },
      { name: 'agentconnect.relay.turn.relayed_bytes', value: 10, attributes: { direction: 'other' } },
      { name: 'agentconnect.relay.turn.dropped_bytes', value: 500, attributes: { reason: 'bandwidth' } },
      { name: 'agentconnect.relay.turn.allocations', value: 1, attributes: { outcome: 'created' } },
      { name: 'agentconnect.relay.turn.allocations_ended', value: 1, attributes: { reason: 'idle', transport: 'tls' } }
    ])
    expect(observed).toEqual([3])
  })
})
