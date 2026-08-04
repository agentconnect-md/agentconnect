import { describe, it, expect } from 'vitest'
import {
  rulesFromAgent,
  resolveCpRule,
  resolveAgentIntegration,
  conversationAdmitted,
  integrationRouting,
  type CpRule
} from '../src/router/routing-rule.js'
import { configuredBotSelfId, integrationConfig, integrationCore } from '../src/platforms/integration-config.js'
import type { Agent, Integration } from '../src/agents/agent-schema.js'

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

describe('integrationRouting (§6.4 core-envelope read)', () => {
  const bindRules = [{ channel: 'C1', match: { kind: 'mention' as const } }]
  // One row per platform, each with the SAME core knobs but its own config block
  // and its own name for the bot's id. The expected values are today's, read from
  // the four arms this replaced.
  const cases: { int: Integration; selfId: string }[] = [
    {
      int: {
        id: 'i-slack',
        platform: 'slack',
        slack: { botToken: 'x', botUserId: 'U-SLACK', bindRules, mutedChannels: ['C9'], gated: true } as any
      },
      selfId: 'U-SLACK'
    },
    {
      int: {
        id: 'i-tg',
        platform: 'telegram',
        telegram: { botToken: 'x', botUserId: 'U-TG', bindRules, mutedChannels: ['C9'], gated: true } as any
      },
      selfId: 'U-TG'
    },
    {
      int: {
        id: 'i-dc',
        platform: 'discord',
        discord: { botToken: 'x', botUserId: 'U-DC', bindRules, mutedChannels: ['C9'], gated: true } as any
      },
      selfId: 'U-DC'
    },
    {
      int: {
        id: 'i-fs',
        platform: 'feishu',
        // Feishu's bot id is an open_id under a DIFFERENT field name — the one
        // knob §6.4 deliberately leaves out of the core envelope.
        feishu: {
          appId: 'cli_x',
          appSecret: 's',
          botOpenId: 'OU-FS',
          bindRules,
          mutedChannels: ['C9'],
          gated: true
        } as any
      },
      selfId: 'OU-FS'
    }
  ]

  it('extracts identical core knobs from every platform config block', () => {
    for (const { int, selfId } of cases) {
      expect(integrationRouting(int)).toEqual({
        staticBotUserId: selfId,
        bindRules,
        mutedChannels: ['C9'],
        gated: true
      })
      // The envelope read and the self-id strategy are separable: core owns one,
      // the platform owns the other.
      expect(integrationCore(int)).toEqual({ bindRules, mutedChannels: ['C9'], gated: true })
      expect(configuredBotSelfId(int)).toBe(selfId)
      expect(integrationConfig(int)).toBe((int as unknown as Record<string, unknown>)[int.platform])
    }
  })

  it('normalizes an absent mutedChannels to empty and an unset bot id to undefined', () => {
    // A hand-assembled integration (fixture / partial spec) never carried the
    // post-hoc `mutedChannels` field; absent means "nothing muted".
    const int = { id: 'i', platform: 'slack', slack: { botToken: 'x', bindRules: [] } } as unknown as Integration
    expect(integrationRouting(int)).toEqual({
      staticBotUserId: undefined,
      bindRules: [],
      mutedChannels: [],
      gated: undefined
    })
  })
})

describe('rulesFromAgent', () => {
  it('derives one resolved RoutingRule per bindRule with the resolved botUserId', () => {
    const rules = rulesFromAgent(agent(), { int1: 'B1' })
    expect(rules).toHaveLength(2)
    expect(rules[0]).toMatchObject({
      agentId: 'agentA',
      integrationId: 'int1',
      botUserId: 'B1',
      match: { kind: 'mention' },
      source: 'config',
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
