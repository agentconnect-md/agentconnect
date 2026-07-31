import { describe, it, expect } from 'vitest'
import {
  rulesFromAgent,
  resolveCpRule,
  resolveAgentIntegration,
  conversationAdmitted,
  type CpRule
} from '../src/router/routing-rule.js'
import type { Agent } from '../src/agents/agent-schema.js'

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'agentA',
    name: 'A',
    status: 'active',
    runtime: 'claude',
    workspace: { mode: 'from-scratch', path: '/tmp/ws', gitBranch: 'main', pullOnNewSession: true, skills: [] },
    integrations: [
      {
        id: 'int1',
        platform: 'slack',
        slack: {
          botToken: 'x',
          appToken: 'y',
          allowedUserIds: ['U1'],
          bindRules: [{ match: { kind: 'mention' } }, { channel: 'C1', match: { kind: 'auto' } }]
        } as any
      }
    ],
    output: { mode: 'medium' },
    permissions: { policy: 'ask', autoApprove: [] },
    crons: [],
    ...over
  } as Agent
}

describe('rulesFromAgent', () => {
  it('derives one resolved RoutingRule per bindRule, with botUserId + allowedUserIds applied', () => {
    const rules = rulesFromAgent(agent(), { int1: 'B1' })
    expect(rules).toHaveLength(2)
    expect(rules[0]).toMatchObject({
      agentId: 'agentA',
      integrationId: 'int1',
      botUserId: 'B1',
      match: { kind: 'mention' },
      source: 'config',
      allowedUserIds: ['U1'],
      scope: {}
    })
    expect(rules[1]).toMatchObject({ match: { kind: 'auto' }, scope: { channel: 'C1' } })
  })

  it("tags each rule with its platform and uses '' when botUserId unknown", () => {
    const rules = rulesFromAgent(agent(), {})
    expect(rules[0]!.botUserId).toBe('')
    expect(rules[0]!.platform).toBe('slack')
  })
})

describe('resolveCpRule', () => {
  const cp: CpRule = { agentId: 'agentA', scope: { channel: 'C9' }, match: { kind: 'auto' }, epoch: 3 }
  it('resolves integrationId + botUserId + platform when the agent is servable', () => {
    const r = resolveCpRule(cp, () => ({ integrationId: 'int1', botUserId: 'B1', platform: 'slack' }))
    expect(r).toMatchObject({
      agentId: 'agentA',
      integrationId: 'int1',
      botUserId: 'B1',
      platform: 'slack',
      source: 'cp',
      epoch: 3,
      scope: { channel: 'C9' }
    })
  })
  it('returns null when unservable (no local agent / no integration)', () => {
    expect(resolveCpRule(cp, () => null)).toBeNull()
  })
})

describe('resolveAgentIntegration', () => {
  it('resolves the first integration + platform; botUserIds overrides the static id', () => {
    const a = agent({
      integrations: [{ id: 'int1', platform: 'slack', slack: { botUserId: 'STATIC', bindRules: [] } as any }]
    })
    expect(resolveAgentIntegration(a, { int1: 'B1' })).toEqual({
      integrationId: 'int1',
      botUserId: 'B1',
      platform: 'slack',
      mutedChannels: []
    })
    // falls back to the static botUserId when the map has no entry
    expect(resolveAgentIntegration(a, {})).toEqual({
      integrationId: 'int1',
      botUserId: 'STATIC',
      platform: 'slack',
      mutedChannels: []
    })
  })

  it('prefers the integration matching the requested platform for a multi-platform agent', () => {
    // Regression: a Slack+Telegram agent must resolve its Telegram integration when a reply
    // is delivered into a Telegram session — else the reply posts through integrations[0]
    // (Slack) and the Telegram chat id fails with channel_not_found.
    const a = agent({
      integrations: [
        { id: 'slack1', platform: 'slack', slack: { botUserId: 'BSLACK', bindRules: [] } as any },
        { id: 'tg1', platform: 'telegram', telegram: { botUserId: 'BTG', bindRules: [] } as any }
      ]
    })
    expect(resolveAgentIntegration(a, {}, 'telegram')).toMatchObject({ integrationId: 'tg1', platform: 'telegram' })
    // Unspecified platform keeps the historical first-integration behavior…
    expect(resolveAgentIntegration(a, {})).toMatchObject({ integrationId: 'slack1', platform: 'slack' })
    // …and an unmatched platform falls back to the first integration rather than returning null.
    expect(resolveAgentIntegration(a, {}, 'discord')).toMatchObject({ integrationId: 'slack1', platform: 'slack' })
  })

  it('returns null when there is no agent', () => {
    expect(resolveAgentIntegration(undefined, {})).toBeNull()
  })

  it('returns null when the agent has no integrations', () => {
    const a = agent({ integrations: [] })
    expect(resolveAgentIntegration(a, {})).toBeNull()
  })
})

describe('conversationAdmitted', () => {
  const routing = (over: Partial<Parameters<typeof conversationAdmitted>[0]> = {}) => ({
    bindRules: [],
    mutedChannels: [],
    gated: false,
    ...over
  })

  it('admits any conversation of an ungated integration with nothing muted', () => {
    expect(conversationAdmitted(routing(), 'C1')).toBe(true)
  })

  it('refuses a muted channel, and a thread inside it', () => {
    const r = routing({ mutedChannels: ['C1'] })
    expect(conversationAdmitted(r, 'C1')).toBe(false)
    expect(conversationAdmitted(r, 'THREAD', 'C1')).toBe(false)
    expect(conversationAdmitted(r, 'C2')).toBe(true)
  })

  // §14: a gated integration is fail-closed — an unknown conversation has no rule.
  it('admits a gated conversation only when a scoped rule enables it', () => {
    const r = routing({ gated: true, bindRules: [{ channel: 'C1', match: { kind: 'mention' } }] })
    expect(conversationAdmitted(r, 'C1')).toBe(true)
    expect(conversationAdmitted(r, 'THREAD', 'C1')).toBe(true)
    expect(conversationAdmitted(r, 'C2')).toBe(false)
  })

  it('lets the mute override an enabling rule — the two fences are independent', () => {
    const r = routing({
      gated: true,
      mutedChannels: ['C1'],
      bindRules: [{ channel: 'C1', match: { kind: 'mention' } }]
    })
    expect(conversationAdmitted(r, 'C1')).toBe(false)
  })
})
