import { describe, expect, it, vi } from 'vitest'
import { createWebchatMcpMetrics, type WebchatMcpMetricInstruments } from './webchat-mcp.js'

function harness() {
  const delegation = { add: vi.fn() }
  const assertion = { add: vi.fn() }
  const invocation = { add: vi.fn() }
  const duration = { record: vi.fn() }
  const instruments = { delegation, assertion, invocation, duration } satisfies WebchatMcpMetricInstruments
  return { metrics: createWebchatMcpMetrics(instruments), delegation, assertion, invocation, duration }
}

describe('webchat MCP metrics', () => {
  it('maps lifecycle transitions to closed, identifier-free attributes', () => {
    const h = harness()

    h.metrics.delegation('established')
    h.metrics.delegation('rotated')
    h.metrics.delegation('expired', undefined, 2)
    h.metrics.delegation('denied', 'conversation_binding')
    h.metrics.assertion('minted')
    h.metrics.assertion('claimed')
    h.metrics.assertion('expired')
    h.metrics.assertion('replayed')
    h.metrics.assertion('conflicted')
    h.metrics.assertion('denied', 'assertion_format')
    h.metrics.invocation('succeeded')
    h.metrics.invocation('failed')
    h.metrics.invocation('in_progress_retry')
    h.metrics.invocation('ambiguous')

    expect(h.delegation.add.mock.calls).toEqual([
      [1, { event: 'established' }],
      [1, { event: 'rotated' }],
      [2, { event: 'expired' }],
      [1, { event: 'denied', reason: 'conversation_binding' }]
    ])
    expect(h.assertion.add.mock.calls).toEqual([
      [1, { event: 'minted' }],
      [1, { event: 'claimed' }],
      [1, { event: 'expired' }],
      [1, { event: 'replayed' }],
      [1, { event: 'conflicted' }],
      [1, { event: 'denied', reason: 'assertion_format' }]
    ])
    expect(h.invocation.add.mock.calls).toEqual([
      [1, { outcome: 'succeeded' }],
      [1, { outcome: 'failed' }],
      [1, { outcome: 'in_progress_retry' }],
      [1, { outcome: 'ambiguous' }]
    ])
    for (const call of [
      ...h.delegation.add.mock.calls,
      ...h.assertion.add.mock.calls,
      ...h.invocation.add.mock.calls
    ]) {
      expect(Object.keys(call[1] as object).sort()).toEqual(
        expect.arrayContaining(
          Object.keys(call[1] as object).filter((key) => ['event', 'reason', 'outcome'].includes(key))
        )
      )
      expect(Object.keys(call[1] as object).every((key) => ['event', 'reason', 'outcome'].includes(key))).toBe(true)
    }
  })

  it('records non-negative request duration with only stage and outcome', () => {
    const h = harness()

    h.metrics.requestDuration('nested_rest', -4, 'failed')
    h.metrics.requestDuration('mcp_http', 12.5, 'succeeded')

    expect(h.duration.record.mock.calls).toEqual([
      [0, { stage: 'nested_rest', outcome: 'failed' }],
      [12.5, { stage: 'mcp_http', outcome: 'succeeded' }]
    ])
  })

  it('does not turn an empty reaper batch into a transition', () => {
    const h = harness()

    h.metrics.delegation('expired', undefined, 0)
    h.metrics.invocation('ambiguous', 0)

    expect(h.delegation.add).not.toHaveBeenCalled()
    expect(h.invocation.add).not.toHaveBeenCalled()
  })

  it('contains throwing observers so metrics never affect behavior', () => {
    const fail = () => {
      throw new Error('exporter failed')
    }
    const metrics = createWebchatMcpMetrics({
      delegation: { add: fail },
      assertion: { add: fail },
      invocation: { add: fail },
      duration: { record: fail }
    })

    expect(() => metrics.delegation('denied', 'delegation_inactive')).not.toThrow()
    expect(() => metrics.assertion('denied', 'claim_denied')).not.toThrow()
    expect(() => metrics.invocation('ambiguous')).not.toThrow()
    expect(() => metrics.requestDuration('nested_rest', Number.NaN, 'failed')).not.toThrow()
  })
})
