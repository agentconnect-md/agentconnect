import { describe, expect, it, vi } from 'vitest'
import type { DecisionBundle } from '@agentconnect.md/protocol'
import { resolveDecisionBundle } from '../src/decisions/bundle.js'

const definition = {
  id: 'd1',
  orgId: 'o',
  name: 'Topic',
  providerId: 'typesafe',
  model: 'jev-1.13.0',
  question: { type: 'choice' as const, instructions: 'Which?', criteria: { billing: 'Money', tech: 'Code' } }
}
const gate = (decisionId = 'd1', key = 'billing') => ({
  type: 'gate' as const,
  decisionId,
  when: { type: 'choice' as const, thresholds: { [key]: 0.5 } }
})

describe('resolveDecisionBundle', () => {
  it('enables a valid gate with its definition', () => {
    const bundle: DecisionBundle = {
      bindings: [{ channel: 'C1', consumer: gate(), enabled: true }],
      definitions: [definition]
    }
    const resolved = resolveDecisionBundle(bundle)
    expect(resolved.gates.get('C1')).toEqual({ channel: 'C1', binding: gate(), definition })
    expect([...resolved.bound]).toEqual(['C1'])
  })

  it('keeps a missing definition, an incompatible condition, an unsupported model, or a disabled binding bound only', () => {
    const warn = vi.fn()
    const bundle: DecisionBundle = {
      bindings: [
        { channel: 'C1', consumer: gate('missing'), enabled: true },
        { channel: 'C2', consumer: gate('d1', 'gone'), enabled: true },
        { channel: 'C3', consumer: gate(), enabled: false, disabledReason: 'needs_review' },
        { channel: 'C4', consumer: gate('d2'), enabled: true },
        { channel: 'C5', consumer: { type: 'shared_bot_routing' }, enabled: true }
      ],
      definitions: [definition, { ...definition, id: 'd2', model: 'unknown-model' }]
    }
    const resolved = resolveDecisionBundle(bundle, warn)
    expect(resolved.gates.size).toBe(0)
    expect([...resolved.bound].sort()).toEqual(['C1', 'C2', 'C3', 'C4', 'C5'])
    expect(warn.mock.calls.map(([m]) => m)).toEqual([
      'decision: binding for C1 disabled (missing definition)',
      'decision: binding for C2 disabled (incompatible condition)',
      'decision: binding for C3 disabled (needs_review)',
      'decision: binding for C4 disabled (unsupported model)',
      'decision: binding for C5 disabled (unsupported consumer shared_bot_routing)'
    ])
  })

  it('warns once per bundle object and holds the channels of an unreadable one', () => {
    const warn = vi.fn()
    const bundle = { bindings: [{ channel: 'C1', consumer: gate('missing'), enabled: true }], definitions: [] }
    resolveDecisionBundle(bundle, warn)
    resolveDecisionBundle(bundle, warn)
    expect(warn).toHaveBeenCalledTimes(1)
    const broken = { bindings: [{ channel: 'C9', consumer: { type: 'gate' }, enabled: true }], definitions: [] }
    expect([...resolveDecisionBundle(broken as unknown as DecisionBundle).bound]).toEqual(['C9'])
  })
})
