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
        core: { bindRules: [{ match: { kind: 'mention' } }, { channel: 'C1', match: { kind: 'auto' } }] },
        config: { botToken: 'x', appToken: 'y' } as any
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
  // One row per platform, each with the SAME core envelope but its own opaque
  // config payload and its own name for the bot's id. The expected values are
  // today's, read from the four arms this replaced.
  const cases: { int: Integration; selfId: string; parsedConfig: Record<string, unknown> }[] = [
    {
      int: {
        id: 'i-slack',
        platform: 'slack',
        core: { mode: 'direct', bindRules, mutedChannels: ['C9'], gated: true },
        config: { botToken: 'x', appToken: 'y', botUserId: 'U-SLACK' }
      } as unknown as Integration,
      selfId: 'U-SLACK',
      parsedConfig: { botToken: 'x', appToken: 'y', botUserId: 'U-SLACK', shareable: false }
    },
    {
      int: {
        id: 'i-tg',
        platform: 'telegram',
        core: { mode: 'direct', bindRules, mutedChannels: ['C9'], gated: true },
        config: { botToken: 'x', botUserId: 'U-TG' }
      } as unknown as Integration,
      selfId: 'U-TG',
      parsedConfig: { botToken: 'x', botUserId: 'U-TG' }
    },
    {
      int: {
        id: 'i-dc',
        platform: 'discord',
        core: { mode: 'direct', bindRules, mutedChannels: ['C9'], gated: true },
        config: { botToken: 'x', botUserId: 'U-DC' }
      } as unknown as Integration,
      selfId: 'U-DC',
      parsedConfig: { botToken: 'x', botUserId: 'U-DC' }
    },
    {
      int: {
        id: 'i-fs',
        platform: 'feishu',
        core: { mode: 'direct', bindRules, mutedChannels: ['C9'], gated: true },
        // Feishu's bot id is an open_id under a DIFFERENT field name — the one
        // knob §6.4 deliberately leaves out of the core envelope.
        config: { appId: 'cli_x', appSecret: 's', botOpenId: 'OU-FS' }
      } as unknown as Integration,
      selfId: 'OU-FS',
      parsedConfig: { appId: 'cli_x', appSecret: 's', botOpenId: 'OU-FS', region: 'feishu' }
    }
  ]

  it('reads identical core knobs from every platform, and the self id from the module config', () => {
    for (const { int, selfId, parsedConfig } of cases) {
      expect(integrationRouting(int)).toEqual({
        staticBotUserId: selfId,
        bindRules,
        mutedChannels: ['C9'],
        gated: true
      })
      // The envelope read and the self-id strategy are separable: core owns one,
      // the platform owns the other.
      expect(integrationCore(int)).toEqual({ mode: 'direct', bindRules, mutedChannels: ['C9'], gated: true })
      expect(configuredBotSelfId(int)).toBe(selfId)
      // The opaque config is the MODULE-VALIDATED parse (schema defaults applied),
      // resolved through the platform registry — not the raw stored value.
      expect(integrationConfig(int)).toEqual(parsedConfig)
    }
  })

  it('fails closed on an unregistered platform id and on a payload the module schema rejects', () => {
    const foreign = {
      id: 'i-x',
      platform: 'mastodon',
      core: { mode: 'direct', bindRules: [], mutedChannels: [], gated: false },
      config: { botToken: 'x' }
    } as unknown as Integration
    expect(integrationConfig(foreign)).toBeUndefined()
    expect(configuredBotSelfId(foreign)).toBeUndefined()
    // A pre-S3 nested-shape entry parses with its block stripped => no config.
    const legacy = {
      id: 'i-legacy',
      platform: 'slack',
      core: { mode: 'direct', bindRules: [], mutedChannels: [], gated: false }
    } as unknown as Integration
    expect(integrationConfig(legacy)).toBeUndefined()
    // Malformed payload (missing the required botToken) => no config, no self id.
    const malformed = {
      id: 'i-bad',
      platform: 'slack',
      core: { mode: 'direct', bindRules: [], mutedChannels: [], gated: false },
      config: { botUserId: 'U-ONLY' }
    } as unknown as Integration
    expect(integrationConfig(malformed)).toBeUndefined()
    expect(configuredBotSelfId(malformed)).toBeUndefined()
    // Prototype names are legal values for an OPEN platform id and must read as
    // unregistered — never resolve `Object.prototype` members into the schema
    // lookup (which would throw mid-convergence instead of skipping the spec).
    for (const platform of ['constructor', 'toString', '__proto__']) {
      const proto = {
        id: `i-${platform}`,
        platform,
        core: { mode: 'direct', bindRules: [], mutedChannels: [], gated: false },
        config: { botToken: 'x' }
      } as unknown as Integration
      expect(integrationConfig(proto)).toBeUndefined()
      expect(configuredBotSelfId(proto)).toBeUndefined()
    }
  })

  it('normalizes an absent mutedChannels to empty and an unset bot id to undefined', () => {
    // A hand-assembled integration (fixture / partial spec) never carried the
    // post-hoc `mutedChannels` field; absent means "nothing muted". `mode` and
    // `gated` normalize to their schema defaults for the same reason.
    const int = {
      id: 'i',
      platform: 'slack',
      core: { bindRules: [] },
      config: { botToken: 'x' }
    } as unknown as Integration
    expect(integrationRouting(int)).toEqual({
      staticBotUserId: undefined,
      bindRules: [],
      mutedChannels: [],
      gated: false
    })
    expect(integrationCore(int).mode).toBe('direct')
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
      integrations: [
        {
          id: 'int1',
          platform: 'slack',
          core: { mode: 'direct', bindRules: [], mutedChannels: [], gated: false },
          config: { botToken: 'x', botUserId: 'STATIC' } as any
        }
      ]
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
        {
          id: 'slack1',
          platform: 'slack',
          core: { mode: 'direct', bindRules: [], mutedChannels: [], gated: false },
          config: { botToken: 'x', botUserId: 'BSLACK' } as any
        },
        {
          id: 'tg1',
          platform: 'telegram',
          core: { mode: 'direct', bindRules: [], mutedChannels: [], gated: false },
          config: { botToken: 'x', botUserId: 'BTG' } as any
        }
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

  it('refuses a muted channel', () => {
    const r = routing({ mutedChannels: ['C1'] })
    expect(conversationAdmitted(r, 'C1')).toBe(false)
    expect(conversationAdmitted(r, 'C2')).toBe(true)
  })

  // §14: a gated integration is fail-closed — an unknown conversation has no rule.
  it('admits a gated conversation only when a scoped rule enables it', () => {
    const r = routing({ gated: true, bindRules: [{ channel: 'C1', match: { kind: 'mention' } }] })
    expect(conversationAdmitted(r, 'C1')).toBe(true)
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
