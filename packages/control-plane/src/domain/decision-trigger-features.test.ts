import { describe, expect, it } from 'vitest'
import { DECISION_TRIGGER_V1_FEATURE, type AttributedRoute, type IntegrationSpec } from '@agentconnect.md/protocol'
import { encodeIntegrationSpecForPeer, encodeRelayRoutesForPeer } from './decision-trigger-features.js'

const gate = { type: 'gate' as const, decisionId: 'd1', when: { type: 'boolean' as const, values: [true] } }
const spec: IntegrationSpec = {
  integrationId: '66666666-6666-4666-8666-666666666666',
  agentId: '77777777-7777-4777-8777-777777777777',
  platform: 'slack',
  core: {
    mode: 'direct',
    bindRules: [{ match: { kind: 'mention' } }, { channel: 'C1', match: { kind: 'decision' } }],
    mutedChannels: ['C9'],
    gated: false,
    sessionModes: [],
    decisions: {
      bindings: [
        { channel: 'C1', consumer: gate, enabled: true },
        { channel: 'C2', consumer: gate, enabled: false, disabledReason: 'needs_review' }
      ],
      definitions: []
    }
  },
  config: {}
}

describe('encodeIntegrationSpecForPeer', () => {
  it('is the identity for a daemon that advertises decision-trigger-v1', () => {
    expect(encodeIntegrationSpecForPeer(spec, [DECISION_TRIGGER_V1_FEATURE])).toBe(spec)
  })

  it('strips decision rules, holds every bound conversation Off, and empties the bundle otherwise', () => {
    const encoded = encodeIntegrationSpecForPeer(spec, ['other'])
    expect(encoded.core.bindRules).toEqual([{ match: { kind: 'mention' } }])
    expect(encoded.core.mutedChannels).toEqual(['C9', 'C1', 'C2'])
    expect(encoded.core.decisions).toEqual({ bindings: [], definitions: [] })
    expect(encodeIntegrationSpecForPeer(spec, undefined).core.bindRules).toHaveLength(1)
  })
})

describe('encodeRelayRoutesForPeer', () => {
  const target = {
    agentId: '77777777-7777-4777-8777-777777777777',
    daemonId: '33333333-3333-4333-8333-333333333333',
    integrationId: '66666666-6666-4666-8666-666666666666'
  }
  const routes: AttributedRoute[] = [
    { ...target, scope: { channel: 'C1' }, match: { kind: 'decision' }, decisionId: 'd1' },
    { ...target, match: { kind: 'keyword', value: 'bob' } }
  ]
  it('strips decision routes and mutes their conversations for an old relay', () => {
    expect(encodeRelayRoutesForPeer({ routes, mutedChannels: [] }, [])).toEqual({
      routes: [routes[1]],
      mutedChannels: ['C1']
    })
    const frame = { routes, mutedChannels: [] }
    expect(encodeRelayRoutesForPeer(frame, [DECISION_TRIGGER_V1_FEATURE])).toBe(frame)
  })
})
