import { describe, expect, it } from 'vitest'
import {
  DECISION_ROUTING_FORWARD_V1_FEATURE,
  DECISION_ROUTING_V1_FEATURE,
  DECISION_TRIGGER_V1_FEATURE,
  type AttributedRoute,
  type IntegrationSpec
} from '@agentconnect.md/protocol'
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

describe('shared-bot routing per peer (decisions.md §7.1)', () => {
  const both = [DECISION_TRIGGER_V1_FEATURE, DECISION_ROUTING_V1_FEATURE]
  const routingDefinition = {
    id: 'd2',
    orgId: 'org',
    name: 'Triage',
    providerId: 'typesafe',
    model: 'jev-1.13.0',
    question: { type: 'boolean' as const, instructions: 'Help?', criteria: { true: 'Yes', false: 'No' } }
  }
  const gateDefinition = { ...routingDefinition, id: 'd1' }
  const routed: IntegrationSpec = {
    ...spec,
    core: {
      ...spec.core,
      mode: 'shared',
      bindRules: [
        { channel: 'C1', match: { kind: 'decision' } },
        { channel: 'R1', match: { kind: 'decision' } }
      ],
      decisions: {
        bindings: [
          { channel: 'C1', consumer: gate, enabled: true },
          { channel: 'R1', consumer: { type: 'shared_bot_routing' }, enabled: true }
        ],
        definitions: [gateDefinition, routingDefinition],
        sharedBotRouting: {
          botId: 'b1',
          config: { enabled: true, decisionId: 'd2', rules: [], otherwise: { type: 'default_agent' } },
          channels: [{ channel: 'R1' }]
        }
      }
    }
  }

  it('strips routing from a daemon with only decision-trigger-v1, keeping its gates', () => {
    const encoded = encodeIntegrationSpecForPeer(routed, [DECISION_TRIGGER_V1_FEATURE])
    expect(encoded.core.bindRules).toEqual([{ channel: 'C1', match: { kind: 'decision' } }])
    expect(encoded.core.mutedChannels).toEqual(['C9', 'R1'])
    expect(encoded.core.decisions).toEqual({
      bindings: [{ channel: 'C1', consumer: gate, enabled: true }],
      definitions: [gateDefinition]
    })
  })

  it('holds everything for a daemon with neither feature and passes a capable daemon unchanged', () => {
    const old = encodeIntegrationSpecForPeer(routed, [])
    expect(old.core.bindRules).toEqual([])
    expect(old.core.mutedChannels).toEqual(['C9', 'R1', 'C1'])
    expect(old.core.decisions).toEqual({ bindings: [], definitions: [] })
    expect(encodeIntegrationSpecForPeer(routed, both)).toBe(routed)
  })

  it('drops routed conversations from a relay without routing-v1, muting them and emptying the list', () => {
    const target = {
      agentId: '77777777-7777-4777-8777-777777777777',
      daemonId: '33333333-3333-4333-8333-333333333333',
      integrationId: '66666666-6666-4666-8666-666666666666'
    }
    const gateRoute: AttributedRoute = {
      ...target,
      scope: { channel: 'C1' },
      match: { kind: 'decision' },
      decisionId: 'd1'
    }
    const routedRoute: AttributedRoute = {
      ...target,
      scope: { channel: 'R1' },
      match: { kind: 'decision' },
      decisionId: 'd2'
    }
    const frame = {
      routes: [gateRoute, routedRoute],
      mutedChannels: [],
      routedConversations: [{ channel: 'R1', decisionId: 'd2', evaluationDaemonId: target.daemonId }]
    }
    expect(encodeRelayRoutesForPeer(frame, [DECISION_TRIGGER_V1_FEATURE])).toEqual({
      routes: [gateRoute],
      mutedChannels: ['R1'],
      routedConversations: []
    })
    // A relay that parses the fields but cannot forward to the host is held exactly the same way.
    expect(encodeRelayRoutesForPeer(frame, both)).toEqual({
      routes: [gateRoute],
      mutedChannels: ['R1'],
      routedConversations: []
    })
    expect(encodeRelayRoutesForPeer(frame, [...both, DECISION_ROUTING_FORWARD_V1_FEATURE])).toBe(frame)
  })
})
