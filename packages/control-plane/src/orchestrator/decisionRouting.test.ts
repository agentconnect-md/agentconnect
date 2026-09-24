import { describe, expect, it } from 'vitest'
import type { SharedBotDecisionRouting } from '@agentconnect.md/protocol'
import { BotId, OrgId } from '../domain/ids.js'
import type { BotDecisionRoutingRecord } from '../persistence/ports.js'
import {
  planRoutedConversations,
  resolveEvaluationHost,
  routingConfigState,
  sharedBotRoutingFor
} from './decisionRouting.js'

const D1 = '33333333-3333-4333-8333-333333333331'
const D2 = '33333333-3333-4333-8333-333333333332'
const D3 = '33333333-3333-4333-8333-333333333333'
const ALICE = '44444444-4444-4444-8444-444444444441'
const BOB = '44444444-4444-4444-8444-444444444442'

const definition = {
  id: 'd1',
  orgId: 'org',
  name: 'Topic',
  providerId: 'typesafe',
  model: 'jev-1.13.0',
  question: { type: 'choice' as const, instructions: 'Which topic?', criteria: { billing: 'Money', tech: 'Code' } }
}
const config: SharedBotDecisionRouting = {
  enabled: true,
  decisionId: 'd1',
  rules: [
    { id: 'r1', when: { type: 'choice', thresholds: { billing: 0.5 } }, action: { type: 'agent', agentId: ALICE } },
    { id: 'r2', when: { type: 'choice', thresholds: { tech: 0.5 } }, action: { type: 'agent', agentId: BOB } }
  ],
  otherwise: { type: 'default_agent' }
}
const record = (over: Partial<BotDecisionRoutingRecord> = {}): BotDecisionRoutingRecord => ({
  botId: BotId('22222222-2222-4222-8222-222222222222'),
  orgId: OrgId('org'),
  config,
  needsReview: false,
  updatedAt: new Date(0),
  definition,
  ...over
})
const created: Record<string, number> = { [D1]: 3, [D2]: 1, [D3]: 1 }
const createdAt = (id: string) => created[id]

describe('resolveEvaluationHost (message-intake.md §6)', () => {
  it("is the default agent's daemon when it is live", () => {
    expect(
      resolveEvaluationHost({ defaultDaemonId: D1, candidateDaemonIds: [D2], live: () => true, createdAt })
    ).toEqual({ daemonId: D1, source: 'default_agent' })
  })

  it('falls back to the earliest-created live candidate, ties broken by id', () => {
    const live = (id: string) => id !== D1
    expect(resolveEvaluationHost({ defaultDaemonId: D1, candidateDaemonIds: [D3, D1, D2], live, createdAt })).toEqual({
      daemonId: D2,
      source: 'earliest_candidate'
    })
    expect(resolveEvaluationHost({ candidateDaemonIds: [D3], live, createdAt })?.daemonId).toBe(D3)
  })

  it('orders a daemon with no stored row last and is null when nothing is live', () => {
    const live = () => true
    expect(
      resolveEvaluationHost({ candidateDaemonIds: ['x', D1], live, createdAt: (id) => created[id] })?.daemonId
    ).toBe(D1)
    expect(resolveEvaluationHost({ defaultDaemonId: D1, candidateDaemonIds: [D2], live: () => false, createdAt })).toBe(
      null
    )
  })
})

describe('routingConfigState', () => {
  const members = new Set([ALICE, BOB])

  it('executes a valid, enabled router of a shared bot', () => {
    expect(routingConfigState(record(), members, true)).toEqual({ executable: true, issues: [] })
  })

  it('pauses a disabled router without discarding it', () => {
    expect(routingConfigState(record({ config: { ...config, enabled: false } }), members, true)).toMatchObject({
      executable: false,
      disabledReason: 'paused'
    })
  })

  it('flags stored review, overlapping keys, an unknown key, a removed target and a non-shared bot', () => {
    expect(routingConfigState(record({ needsReview: true }), members, true).disabledReason).toBe('needs_review')
    const overlap = { ...config, rules: [config.rules[0]!, { ...config.rules[0]!, id: 'r3' }] }
    expect(routingConfigState(record({ config: overlap }), members, true).issues[0]?.message).toMatch(/only one/)
    const unknown = {
      ...config,
      rules: [{ ...config.rules[0]!, when: { type: 'choice' as const, thresholds: { gone: 0.5 } } }]
    }
    expect(routingConfigState(record({ config: unknown }), members, true).executable).toBe(false)
    expect(routingConfigState(record(), new Set([ALICE]), true)).toMatchObject({
      executable: false,
      disabledReason: 'needs_review',
      issues: [{ path: ['rules', 1, 'action'], message: 'Choose an agent connected to this bot.' }]
    })
    expect(routingConfigState(record(), members, false).disabledReason).toBe('needs_review')
    // Review outranks pause, so a paused router with a stale rule still asks for repair.
    const both = record({ needsReview: true, config: { ...config, enabled: false } })
    expect(routingConfigState(both, members, true).disabledReason).toBe('needs_review')
  })

  it('holds a missing record or definition', () => {
    expect(routingConfigState(null, members, true).executable).toBe(false)
    expect(routingConfigState(record({ definition: null }), members, true).disabledReason).toBe('access_revoked')
  })

  it('locates a removed target in its child step', () => {
    const chained = {
      ...config,
      rules: [{ ...config.rules[0]!, action: { type: 'decision' as const, nextStepId: 'follow' } }],
      steps: [{ id: 'follow', decisionId: definition.id, rules: [config.rules[1]!] }]
    }
    expect(routingConfigState(record({ config: chained }), new Set([ALICE]), true).issues).toEqual([
      { path: ['steps', 0, 'rules', 0, 'action'], message: 'Choose an agent connected to this bot.' }
    ])
  })
})

describe('planRoutedConversations', () => {
  const plan = (over: Partial<Parameters<typeof planRoutedConversations>[0]> = {}) =>
    planRoutedConversations({
      config,
      state: { executable: true, issues: [] },
      conversations: [{ channel: 'C1', defaultAgentId: ALICE, candidateDaemonIds: [D1, D2] }],
      defaultDaemonId: D1,
      live: () => true,
      createdAt,
      hostSupported: () => true,
      ...over
    })

  it('names the host and holds nothing when every input is ready', () => {
    expect(plan()).toEqual([
      {
        channel: 'C1',
        decisionId: 'd1',
        evaluationDaemonId: D1,
        hostSource: 'default_agent',
        defaultAgentId: ALICE,
        hold: null
      }
    ])
  })

  it('chooses a host lacking the feature and holds it, never skipping to another daemon', () => {
    const [entry] = plan({ hostSupported: (id) => id !== D1 })
    expect(entry).toMatchObject({ evaluationDaemonId: D1, hold: 'host_unsupported' })
  })

  it('holds for config, owner, and host liveness in that order', () => {
    expect(plan({ state: { executable: false, disabledReason: 'paused', issues: [] } })[0]?.hold).toBe('paused')
    expect(plan({ conversations: [{ channel: 'C1', candidateDaemonIds: [D1] }] })[0]?.hold).toBe('owner_unavailable')
    expect(plan({ live: () => false })[0]).toMatchObject({ evaluationDaemonId: null, hold: 'host_offline' })
    expect(
      plan({
        conversations: [{ channel: 'C1', defaultAgentId: ALICE, candidateDaemonIds: [D1], rowHold: 'needs_review' }]
      })[0]?.hold
    ).toBe('needs_review')
  })
})

describe('sharedBotRoutingFor', () => {
  const entries = planRoutedConversations({
    config,
    state: { executable: true, issues: [] },
    conversations: [
      { channel: 'C1', defaultAgentId: ALICE, candidateDaemonIds: [D2] },
      { channel: 'C2', defaultAgentId: BOB, candidateDaemonIds: [D2] },
      { channel: 'C3', candidateDaemonIds: [D2] }
    ],
    live: () => true,
    createdAt,
    hostSupported: () => true
  })

  it('projects only the unheld conversations the daemon hosts, with their default agents', () => {
    expect(sharedBotRoutingFor(entries, { botId: 'b1', config }, D2)).toEqual({
      botId: 'b1',
      config,
      channels: [
        { channel: 'C1', defaultAgentId: ALICE },
        { channel: 'C2', defaultAgentId: BOB }
      ]
    })
    expect(sharedBotRoutingFor(entries, { botId: 'b1', config }, D1)).toBeUndefined()
  })
})
