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
      'decision: binding for C4 disabled (unsupported model)'
    ])
    // A router binding is bound and held, never a gate, and without a host projection it carries no config.
    expect(resolved.routed.get('C5')).toEqual({ channel: 'C5', enabled: true })
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

describe('resolveDecisionBundle — shared-bot routing (decisions.md §7.1)', () => {
  const agent = '00000000-0000-4000-8000-00000000000a'
  const config = {
    enabled: true,
    decisionId: 'd1',
    rules: [
      {
        id: 'r1',
        when: { type: 'choice' as const, thresholds: { billing: 0.5 } },
        action: { type: 'agent' as const, agentId: agent }
      }
    ],
    otherwise: { type: 'default_agent' as const }
  }
  const router = { type: 'shared_bot_routing' as const }
  const routed = (over: Partial<DecisionBundle> = {}): DecisionBundle => ({
    bindings: [
      { channel: 'R1', consumer: router, enabled: true },
      { channel: 'R2', consumer: router, enabled: true },
      { channel: 'R3', consumer: router, enabled: false, disabledReason: 'paused' },
      { channel: 'G1', consumer: gate(), enabled: true }
    ],
    definitions: [definition],
    sharedBotRouting: {
      botId: 'b1',
      config,
      channels: [{ channel: 'R1', defaultAgentId: agent }, { channel: 'R3' }]
    },
    ...over
  })

  it('resolves the router only for the enabled channels this daemon hosts', () => {
    const resolved = resolveDecisionBundle(routed())
    expect(resolved.sharedBotRouting).toEqual({ botId: 'b1', config })
    expect(resolved.routed.get('R1')).toEqual({
      channel: 'R1',
      enabled: true,
      routing: { botId: 'b1', config, definition, defaultAgentId: agent }
    })
    expect(resolved.routed.get('R2')).toEqual({ channel: 'R2', enabled: true })
    expect(resolved.routed.get('R3')).toEqual({ channel: 'R3', enabled: false, disabledReason: 'paused' })
    expect([...resolved.gates.keys()]).toEqual(['G1'])
    expect([...resolved.bound].sort()).toEqual(['G1', 'R1', 'R2', 'R3'])
  })

  it('holds routed channels without a config when the projection is invalid, keeping the gates', () => {
    const warn = vi.fn()
    const overlapping = {
      ...config,
      rules: [config.rules[0]!, { ...config.rules[0]!, id: 'r2' }]
    }
    for (const sharedBotRouting of [
      { botId: 'b1', config: overlapping, channels: [{ channel: 'R1' }] },
      { botId: 'b1', config: { ...config, decisionId: 'missing' }, channels: [{ channel: 'R1' }] },
      { botId: 'b1', config: { ...config, extra: true }, channels: [{ channel: 'R1' }] }
    ]) {
      const resolved = resolveDecisionBundle(routed({ sharedBotRouting } as never), warn)
      expect(resolved.routed.get('R1')).toEqual({ channel: 'R1', enabled: true })
      expect(resolved.sharedBotRouting).toBeUndefined()
      expect([...resolved.gates.keys()]).toEqual(['G1'])
    }
    expect(warn).toHaveBeenCalledWith(
      'decision: shared-bot routing failed validation; holding every routed conversation'
    )
  })
})
