import { describe, expect, it, vi } from 'vitest'
import { createDelegatedMcpMetrics, type DelegatedMcpMetricInstruments } from '../src/mcp/delegated-metrics.js'

function harness() {
  const isolation = { add: vi.fn() }
  const denial = { add: vi.fn() }
  const duration = { record: vi.fn() }
  const instruments = { isolation, denial, duration } satisfies DelegatedMcpMetricInstruments
  return { metrics: createDelegatedMcpMetrics(instruments), isolation, denial, duration }
}

describe('delegated MCP metrics', () => {
  it('maps isolation lifecycle and denial reasons to closed attributes', () => {
    const h = harness()

    h.metrics.isolation('created')
    h.metrics.isolation('resumed')
    h.metrics.isolation('destroyed')
    h.metrics.isolation('failed', 'cell_creation')
    h.metrics.denied('broker_validation')
    h.metrics.denied('fence')
    h.metrics.denied('capacity')
    h.metrics.denied('token_mismatch')
    h.metrics.denied('capability_probe_failed')

    expect(h.isolation.add.mock.calls).toEqual([
      [1, { event: 'created' }],
      [1, { event: 'resumed' }],
      [1, { event: 'destroyed' }],
      [1, { event: 'failed', reason: 'cell_creation' }]
    ])
    expect(h.denial.add.mock.calls).toEqual([
      [1, { reason: 'broker_validation' }],
      [1, { reason: 'fence' }],
      [1, { reason: 'capacity' }],
      [1, { reason: 'token_mismatch' }],
      [1, { reason: 'capability_probe_failed' }]
    ])
    for (const call of [...h.isolation.add.mock.calls, ...h.denial.add.mock.calls]) {
      expect(Object.keys(call[1] as object).every((key) => ['event', 'reason'].includes(key))).toBe(true)
    }
  })

  it('records non-negative mint and HTTP latency with closed outcomes', () => {
    const h = harness()

    h.metrics.requestDuration('mint_ws', -1, 'failed')
    h.metrics.requestDuration('mcp_http', 7, 'succeeded')

    expect(h.duration.record.mock.calls).toEqual([
      [0, { stage: 'mint_ws', outcome: 'failed' }],
      [7, { stage: 'mcp_http', outcome: 'succeeded' }]
    ])
  })

  it('does not turn an empty aggregate into a transition', () => {
    const h = harness()

    h.metrics.isolation('destroyed', undefined, 0)
    h.metrics.denied('capacity', 0)

    expect(h.isolation.add).not.toHaveBeenCalled()
    expect(h.denial.add).not.toHaveBeenCalled()
  })

  it('contains throwing observers so metrics never affect broker behavior', () => {
    const fail = () => {
      throw new Error('exporter failed')
    }
    const metrics = createDelegatedMcpMetrics({
      isolation: { add: fail },
      denial: { add: fail },
      duration: { record: fail }
    })

    expect(() => metrics.isolation('created')).not.toThrow()
    expect(() => metrics.denied('token_mismatch')).not.toThrow()
    expect(() => metrics.requestDuration('mcp_http', Number.POSITIVE_INFINITY, 'failed')).not.toThrow()
  })
})
