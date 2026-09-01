/**
 * `integrationToSpec` — the per-channel trigger → wire bindRules fold (unit, no I/O).
 *
 * The delivered rule set is the defaults (@-mention anywhere + DMs) plus one scoped
 * `auto` rule per room switched to "any message". A room left on '@-mention' adds no
 * extra rule; a 1:1 DM's On state uses the unscoped DM default.
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { gatesNewConversations, httpIntegrationToSpec, integrationToSpec } from './placement.js'
import { agentRecordToSpec } from './agentSpecAssembler.js'
import type { AgentRecord, BotRecord, IntegrationChannelRecord, IntegrationRecord } from '../persistence/ports.js'
import { AgentId, BotId, IntegrationId, OrgId } from '../domain/ids.js'
import { buildCpPlatformRegistry } from '../platforms/registry.js'
import { createSlackCpProvider } from '../platforms/slack/provider.js'
import { createTelegramCpProvider } from '../platforms/telegram/provider.js'
import { createDiscordCpProvider } from '../platforms/discord/provider.js'
import { createFeishuCpProvider } from '../platforms/feishu/provider.js'
import {
  IntegrationSlackConfig,
  IntegrationTelegramConfig,
  IntegrationDiscordConfig,
  IntegrationFeishuConfig
} from '@agentconnect.md/protocol'

// The §9 projector seam: spec assembly now awaits the platform provider for the
// opaque `config` payload, so every call needs the registry + the bot row. The
// four providers are constructed with offline stubs — the projectors reach none
// of them (they are pure functions of the row + the decrypted secret).
const PLATFORMS = buildCpPlatformRegistry([
  createSlackCpProvider({}),
  createTelegramCpProvider({ verifyBot: async () => ({ status: 'unreachable' }) }),
  createDiscordCpProvider({ ensureMessageContentIntent: async () => 'ready' }),
  createFeishuCpProvider({})
])

// §6.4 emission flip: the spec carries envelope (`core`) + opaque `config` only.
// Tests validate the payload through the SAME wire schema the daemon reader uses.
const slackCfg = (spec: { config?: unknown }) => IntegrationSlackConfig.parse(spec.config)
const telegramCfg = (spec: { config?: unknown }) => IntegrationTelegramConfig.parse(spec.config)
const discordCfg = (spec: { config?: unknown }) => IntegrationDiscordConfig.parse(spec.config)
const feishuCfg = (spec: { config?: unknown }) => IntegrationFeishuConfig.parse(spec.config)

const INTEGRATION: IntegrationRecord = {
  id: IntegrationId('66666666-6666-4666-8666-666666666666'),
  orgId: OrgId('org'),
  agentId: AgentId('77777777-7777-4777-8777-777777777777'),
  botId: BotId('88888888-8888-4888-8888-888888888888'),
  platform: 'slack',
  name: 'acme-bot',
  status: 'active',
  createdAt: new Date('2026-01-01T00:00:00Z')
}
const SECRET = { botToken: 'xoxb-abc', appToken: 'xapp-def', signingSecret: null }

/** A socket-transport bot row — the direct-mode fork the projector applies. Only
 *  the fields the four projectors read are meaningful. */
const bot = (over: Partial<BotRecord> = {}): BotRecord =>
  ({
    id: BotId('88888888-8888-4888-8888-888888888888'),
    orgId: OrgId('org'),
    platform: 'slack',
    name: 'acme-bot',
    transport: 'socket',
    shareable: false,
    slackAppId: null,
    teamId: null,
    botUserId: null,
    ...over
  }) as BotRecord

/** `integrationToSpec` with the registry + the matching bot row pre-bound, so the
 *  cases below keep reading as the trigger→bindRules fold they are testing. */
const specOf = async (
  i: IntegrationRecord,
  secret: Parameters<typeof integrationToSpec>[3],
  channels: IntegrationChannelRecord[] = [],
  gated = false
) => {
  // Every platform exercised here always has a deliverable payload; `null` is the
  // withheld-integration answer, pinned in its own suite below.
  const spec = await integrationToSpec(PLATFORMS, i, bot({ platform: i.platform }), secret, channels, gated)
  if (!spec) throw new Error('expected a deliverable spec')
  return spec
}

const channel = (
  channelId: string,
  trigger: 'off' | 'mention' | 'any',
  kind: 'channel' | 'im' | 'mpim' = 'channel'
): IntegrationChannelRecord => ({
  integrationId: INTEGRATION.id,
  channelId,
  name: channelId.toLowerCase(),
  spaceId: null,
  space: null,
  isPrivate: false,
  kind,
  trigger,
  dmUserId: null,
  triggerChosen: false,
  agentId: null
})

describe('integrationToSpec bindRules', () => {
  it('defaults to mention + dm with no channels', async () => {
    const spec = await specOf(INTEGRATION, SECRET)
    expect(spec.core.bindRules).toEqual([{ match: { kind: 'mention' } }, { match: { kind: 'dm' } }])
    expect(slackCfg(spec).botToken).toBe(SECRET.botToken)
  })

  it("adds one channel-scoped 'auto' rule per 'any message' channel; 'mention' channels add none", async () => {
    const spec = await specOf(INTEGRATION, SECRET, [
      channel('C1', 'mention'),
      channel('C2', 'any'),
      channel('C3', 'any')
    ])
    expect(spec.core.bindRules).toEqual([
      { match: { kind: 'mention' } },
      { match: { kind: 'dm' } },
      { channel: 'C2', match: { kind: 'auto' } },
      { channel: 'C3', match: { kind: 'auto' } }
    ])
  })

  it('uses the DM default for a 1:1 row and scopes a group DM set to "any"', async () => {
    const spec = await specOf(INTEGRATION, SECRET, [
      channel('C1', 'any'),
      channel('D1', 'any', 'im'),
      channel('G1', 'any', 'mpim')
    ])
    expect(spec.core.bindRules).toEqual([
      { match: { kind: 'mention' } },
      { match: { kind: 'dm' } },
      { channel: 'C1', match: { kind: 'auto' } },
      { channel: 'G1', match: { kind: 'auto' } }
    ])
  })

  it('emits a telegram-shaped spec (single botToken, no appToken) for a telegram integration', async () => {
    const spec = await specOf(
      { ...INTEGRATION, platform: 'telegram' },
      { botToken: '123:abc', appToken: null, signingSecret: null },
      [channel('-100', 'any')]
    )
    if (spec.platform !== 'telegram') throw new Error('expected telegram spec')
    expect(telegramCfg(spec).botToken).toBe('123:abc')
    expect(spec).not.toHaveProperty('slack')
    expect(spec.core.bindRules).toEqual([
      { match: { kind: 'mention' } },
      { match: { kind: 'dm' } },
      { channel: '-100', match: { kind: 'auto' } }
    ])
  })
})

describe('integrationToSpec conversation gating (§14)', () => {
  it('gated: emits ONLY conversation-scoped rules — no unscoped defaults', async () => {
    const spec = await specOf(
      INTEGRATION,
      SECRET,
      [channel('C1', 'mention'), channel('C2', 'any'), channel('C3', 'off'), channel('D1', 'any', 'im')],
      true
    )
    if (spec.platform !== 'slack') throw new Error('expected slack spec')
    expect(spec.core.gated).toBe(true)
    expect(spec.core.bindRules).toEqual([
      { channel: 'C1', match: { kind: 'mention' } },
      { channel: 'C2', match: { kind: 'auto' } },
      { channel: 'D1', match: { kind: 'dm' } }
    ])
  })

  it('gated with no enabled conversations ships an EMPTY rule set (fail-closed)', async () => {
    const spec = await specOf(INTEGRATION, SECRET, [channel('C1', 'off'), channel('D1', 'off', 'im')], true)
    if (spec.platform !== 'slack') throw new Error('expected slack spec')
    expect(spec.core.bindRules).toEqual([])
    expect(spec.core.gated).toBe(true)
  })

  it("non-gated: an 'off' channel keeps the defaults but is muted; gated is false", async () => {
    const spec = await specOf(INTEGRATION, SECRET, [channel('C1', 'off'), channel('D1', 'any', 'im')])
    if (spec.platform !== 'slack') throw new Error('expected slack spec')
    expect(spec.core.gated).toBe(false)
    // The defaults are unscoped, so Off cannot be expressed by withholding a rule —
    // the fence is what silences C1. The im row adds no auto rule either; DMs are
    // covered by the unscoped dm default.
    expect(spec.core.bindRules).toEqual([{ match: { kind: 'mention' } }, { match: { kind: 'dm' } }])
    expect(spec.core.mutedChannels).toEqual(['C1'])
  })
})

describe('integrationToSpec mutedChannels', () => {
  it('mutes every Off channel and nothing else', async () => {
    const spec = await specOf(INTEGRATION, SECRET, [
      channel('C1', 'off'),
      channel('C2', 'mention'),
      channel('C3', 'any'),
      channel('C4', 'off')
    ])
    if (spec.platform !== 'slack') throw new Error('expected slack spec')
    expect(spec.core?.mutedChannels).toEqual(['C1', 'C4'])
  })

  it('mutes direct rows on a non-gated integration', async () => {
    const spec = await specOf(INTEGRATION, SECRET, [channel('D1', 'off', 'im'), channel('G1', 'off', 'mpim')])
    if (spec.platform !== 'slack') throw new Error('expected slack spec')
    expect(spec.core?.mutedChannels).toEqual(['D1', 'G1'])
  })

  // A gated integration says Off by having no rule for the conversation; stating it
  // twice would let the two representations drift apart.
  it('stays empty for a gated integration, whose Off is the missing rule', async () => {
    const spec = await specOf(INTEGRATION, SECRET, [channel('C1', 'off'), channel('C2', 'mention')], true)
    if (spec.platform !== 'slack') throw new Error('expected slack spec')
    expect(spec.core?.mutedChannels).toEqual([])
    expect(spec.core?.bindRules).toEqual([{ channel: 'C2', match: { kind: 'mention' } }])
  })

  it('rides every platform variant', async () => {
    const tg = await specOf(
      { ...INTEGRATION, platform: 'telegram' },
      { botToken: '1:a', appToken: null, signingSecret: null },
      [channel('-100', 'off')]
    )
    if (tg.platform !== 'telegram') throw new Error('expected telegram spec')
    expect(tg.core?.mutedChannels).toEqual(['-100'])
    const dc = await specOf(
      { ...INTEGRATION, platform: 'discord' },
      { botToken: 'bot', appToken: null, signingSecret: null },
      [channel('999', 'off')]
    )
    if (dc.platform !== 'discord') throw new Error('expected discord spec')
    expect(dc.core?.mutedChannels).toEqual(['999'])
    const fs = await specOf(
      { ...INTEGRATION, platform: 'feishu' },
      { botToken: 'sec', appToken: 'cli_x', signingSecret: null },
      [channel('oc_1', 'off')]
    )
    if (fs.platform !== 'feishu') throw new Error('expected feishu spec')
    expect(fs.core?.mutedChannels).toEqual(['oc_1'])
  })
})

/**
 * §9 projector seam: core owns the envelope and ONE fail-closed fence — a
 * registered provider is required; the opaque `config` is the provider's. The
 * fence is unreachable in production — every persistence write already passes
 * `toDbPlatform` and the create route admits only registered platform ids —
 * but the pre-S3 code's unrecognized-platform arm silently FELL THROUGH to the
 * slack branch, so pin that it does not any more. (The wire-side `toDbPlatform`
 * narrowing died with the union flatten: `IntegrationSpec.platform` is open, so
 * the session-identity and unknown ids below now hit the same provider refusal
 * instead of the persistence fence's two messages. `toDbPlatform` itself lives
 * on unchanged at every persistence write.)
 */
describe('integrationToSpec platform fences (§9)', () => {
  const foreign = { ...INTEGRATION, platform: 'mastodon' }

  it('refuses an id no provider is registered for instead of falling through to slack', async () => {
    const withoutSlack = buildCpPlatformRegistry([
      createTelegramCpProvider({ verifyBot: async () => ({ status: 'unreachable' }) })
    ])
    // A SERVED id (slack) whose provider is simply not composed — the case that
    // reaches the provider fence rather than `toDbPlatform`'s served-set check.
    await expect(integrationToSpec(withoutSlack, INTEGRATION, bot(), SECRET, [], false)).rejects.toThrow(
      /no control-plane platform provider registered for slack/
    )
  })

  it('refuses an id outside the served set at the provider fence', async () => {
    await expect(
      integrationToSpec(PLATFORMS, foreign, bot({ platform: 'mastodon' }), SECRET, [], false)
    ).rejects.toThrow(/no control-plane platform provider registered for mastodon/)
  })

  it('refuses a session-identity id, which has no persisted integration at all', async () => {
    const webchat = { ...INTEGRATION, platform: 'webchat' }
    await expect(
      integrationToSpec(PLATFORMS, webchat, bot({ platform: 'webchat' }), SECRET, [], false)
    ).rejects.toThrow(/no control-plane platform provider registered for webchat/)
  })
})

/**
 * A provider whose own credential store has nothing for this row answers
 * `undefined`, and core must turn that into ABSENCE, not into a spec with an
 * empty payload.
 *
 * The distinction is the whole point: the daemon's reader refuses a config-less
 * spec and KEEPS the entry it already holds (`CpIntegrationRegistry.converge`
 * only ever sets), so a config-less spec would leave a revoked credential
 * running. `null` instead keeps the row out of the deliverable roster, which is
 * exactly what `drop.integrations` prunes — the same exit a missing secret row
 * already takes.
 */
describe('a provider with no deliverable payload withholds the integration', () => {
  const withheld = buildCpPlatformRegistry([
    {
      platformId: 'slack',
      installRoutes: () => [],
      credentialBodySchema: z.object({}),
      validateConfig: () => Promise.resolve({ ok: true as const, identity: {} }),
      buildNewBotInstall: () => ({ secrets: { botToken: '', appToken: null, signingSecret: null } }),
      secretShape: { slots: {}, httpAssignRequires: [] },
      projectIntegrationConfig: () => Promise.resolve(undefined)
    }
  ])

  it('answers null from the direct (socket) assembler', async () => {
    expect(await integrationToSpec(withheld, INTEGRATION, bot(), SECRET, [], false)).toBeNull()
  })

  it('answers null from the shared (http) assembler', async () => {
    expect(await httpIntegrationToSpec(withheld, INTEGRATION, bot({ transport: 'http' }), SECRET, [], false)).toBeNull()
  })

  it('still emits a spec when the provider returns a payload, including a falsy one', async () => {
    // `undefined` is the ONLY withholding answer — an empty-object payload is a
    // legitimate config and must not be mistaken for an absent credential.
    const empty = buildCpPlatformRegistry([
      {
        platformId: 'slack',
        installRoutes: () => [],
        credentialBodySchema: z.object({}),
        validateConfig: () => Promise.resolve({ ok: true as const, identity: {} }),
        buildNewBotInstall: () => ({ secrets: { botToken: '', appToken: null, signingSecret: null } }),
        secretShape: { slots: {}, httpAssignRequires: [] },
        projectIntegrationConfig: () => Promise.resolve({})
      }
    ])
    expect(await integrationToSpec(empty, INTEGRATION, bot(), SECRET, [], false)).toMatchObject({
      integrationId: INTEGRATION.id,
      config: {}
    })
  })
})

describe('agentRecordToSpec runtime overrides', () => {
  it('ships displayName as either its value or explicit null so clearing it replicates', () => {
    const agent: AgentRecord = {
      id: AgentId('77777777-7777-4777-8777-777777777777'),
      orgId: OrgId('org'),
      name: 'deploy-bot',
      displayName: 'Deploy Bot',
      builtin: false,
      icon: null,
      description: null,
      runtime: 'claude-acp',
      model: null,
      reasoningEffort: null,
      outputMode: null,
      showFooter: true,
      showStatusBar: false,
      fastMode: null,
      permissionMode: null,
      allowRuntimeChangesInChat: false,
      pause: null,
      env: {},
      mcpServers: [],
      skills: [],
      managedSkills: [],
      memory: null,
      status: 'active',
      placementKind: 'daemon',
      daemonId: null,
      setId: null,
      workspace: { mode: 'scratch' },
      capabilities: [],
      createdAt: new Date('2026-01-01T00:00:00Z'),
      createdBy: null,
      createdByUserId: null,
      visibility: 'org',
      sharedWith: [],
      callPolicy: 'all',
      allowedCallerAgentIds: [],
      outboundPolicy: 'all',
      allowedTargetAgentIds: [],
      introduceOnJoin: false,
      runInSandbox: false,
      lastModifiedAt: new Date('2026-01-01T00:00:00Z'),
      lastModifiedBy: null,
      configRevision: 0n
    }

    expect(agentRecordToSpec(agent, {})).toHaveProperty('displayName', 'Deploy Bot')
    expect(agentRecordToSpec({ ...agent, displayName: null }, {})).toHaveProperty('displayName', null)
    expect(agentRecordToSpec(agent, {}).workspace).toEqual({
      mode: 'scratch',
      isolation: 'shared',
      gitCredential: 'github-app',
      additionalRepos: []
    })
    // The preset marker always ships (definite record field) so the daemon can
    // gate preset-only behavior such as `agentconnect-admin` attachment.
    expect(agentRecordToSpec(agent, {})).toHaveProperty('builtin', false)
    expect(agentRecordToSpec({ ...agent, builtin: true }, {})).toHaveProperty('builtin', true)
  })

  it('carries permissionMode to the daemon spec', () => {
    const agent: AgentRecord = {
      id: AgentId('77777777-7777-4777-8777-777777777777'),
      orgId: OrgId('org'),
      name: 'deploy-bot',
      displayName: 'Deploy Bot',
      builtin: false,
      icon: null,
      description: null,
      runtime: 'claude-acp',
      model: null,
      reasoningEffort: null,
      outputMode: null,
      showFooter: true,
      showStatusBar: false,
      fastMode: null,
      permissionMode: 'plan',
      allowRuntimeChangesInChat: false,
      pause: null,
      env: {},
      mcpServers: [],
      skills: [],
      managedSkills: [],
      memory: null,
      status: 'active',
      placementKind: 'daemon',
      daemonId: null,
      setId: null,
      workspace: { mode: 'scratch' },
      capabilities: [],
      createdAt: new Date('2026-01-01T00:00:00Z'),
      createdBy: null,
      createdByUserId: null,
      visibility: 'org',
      sharedWith: [],
      callPolicy: 'all',
      allowedCallerAgentIds: [],
      outboundPolicy: 'all',
      allowedTargetAgentIds: [],
      introduceOnJoin: false,
      runInSandbox: false,
      lastModifiedAt: new Date('2026-01-01T00:00:00Z'),
      lastModifiedBy: null,
      configRevision: 0n
    }

    expect(agentRecordToSpec(agent, {})).toMatchObject({ permissionMode: 'plan' })
  })

  it('carries pause to the daemon spec, and omits it when null (#288)', () => {
    const base: AgentRecord = {
      id: AgentId('77777777-7777-4777-8777-777777777777'),
      orgId: OrgId('org'),
      name: 'deploy-bot',
      displayName: 'Deploy Bot',
      builtin: false,
      icon: null,
      description: null,
      runtime: 'claude-acp',
      model: null,
      reasoningEffort: null,
      outputMode: null,
      showFooter: true,
      showStatusBar: false,
      fastMode: null,
      permissionMode: null,
      allowRuntimeChangesInChat: false,
      pause: true,
      env: {},
      mcpServers: [],
      skills: [],
      managedSkills: [],
      memory: null,
      status: 'active',
      placementKind: 'daemon',
      daemonId: null,
      setId: null,
      workspace: { mode: 'scratch' },
      capabilities: [],
      createdAt: new Date('2026-01-01T00:00:00Z'),
      createdBy: null,
      createdByUserId: null,
      visibility: 'org',
      sharedWith: [],
      callPolicy: 'all',
      allowedCallerAgentIds: [],
      outboundPolicy: 'all',
      allowedTargetAgentIds: [],
      introduceOnJoin: false,
      runInSandbox: false,
      lastModifiedAt: new Date('2026-01-01T00:00:00Z'),
      lastModifiedBy: null,
      configRevision: 0n
    }

    expect(agentRecordToSpec(base, {})).toMatchObject({ pause: true })
    // null ⇒ the key is omitted, so the daemon merge leaves the on-disk value alone.
    expect(agentRecordToSpec({ ...base, pause: null }, {})).not.toHaveProperty('pause')
    // #536: introduceOnJoin is a definite column value, always shipped so a toggle replicates.
    expect(agentRecordToSpec({ ...base, introduceOnJoin: true }, {})).toMatchObject({ introduceOnJoin: true })
    expect(agentRecordToSpec({ ...base, introduceOnJoin: false }, {})).toMatchObject({ introduceOnJoin: false })
  })

  it('carries the memory backend to the daemon spec, and omits it when null', () => {
    const base: AgentRecord = {
      id: AgentId('88888888-8888-4888-8888-888888888888'),
      orgId: OrgId('org'),
      name: 'mem-bot',
      displayName: 'Mem Bot',
      builtin: false,
      icon: null,
      description: null,
      runtime: 'claude-acp',
      model: null,
      reasoningEffort: null,
      outputMode: null,
      showFooter: true,
      showStatusBar: false,
      fastMode: null,
      permissionMode: null,
      allowRuntimeChangesInChat: false,
      pause: null,
      env: {},
      mcpServers: [],
      skills: [],
      managedSkills: [],
      memory: { provider: 'native' },
      status: 'active',
      placementKind: 'daemon',
      daemonId: null,
      setId: null,
      workspace: { mode: 'scratch' },
      capabilities: [],
      createdAt: new Date('2026-01-01T00:00:00Z'),
      createdBy: null,
      createdByUserId: null,
      visibility: 'org',
      sharedWith: [],
      callPolicy: 'all',
      allowedCallerAgentIds: [],
      outboundPolicy: 'all',
      allowedTargetAgentIds: [],
      introduceOnJoin: false,
      runInSandbox: false,
      lastModifiedAt: new Date('2026-01-01T00:00:00Z'),
      lastModifiedBy: null,
      configRevision: 0n
    }

    expect(agentRecordToSpec(base, {})).toMatchObject({ memory: { provider: 'native' } })
    // null ⇒ omitted, so switching-then-clearing leaves the on-disk value alone.
    expect(agentRecordToSpec({ ...base, memory: null }, {})).not.toHaveProperty('memory')
  })

  it('ships a cleared model/effort/permissionMode as explicit null so a runtime switch replicates the clear', () => {
    const base: AgentRecord = {
      id: AgentId('77777777-7777-4777-8777-777777777777'),
      orgId: OrgId('org'),
      name: 'deploy-bot',
      displayName: 'Deploy Bot',
      builtin: false,
      icon: null,
      description: null,
      runtime: 'claude-acp',
      model: null,
      reasoningEffort: null,
      outputMode: null,
      showFooter: true,
      showStatusBar: false,
      fastMode: null,
      permissionMode: null,
      allowRuntimeChangesInChat: false,
      pause: null,
      env: {},
      mcpServers: [],
      skills: [],
      managedSkills: [],
      memory: null,
      status: 'active',
      placementKind: 'daemon',
      daemonId: null,
      setId: null,
      workspace: { mode: 'scratch' },
      capabilities: [],
      createdAt: new Date('2026-01-01T00:00:00Z'),
      createdBy: null,
      createdByUserId: null,
      visibility: 'org',
      sharedWith: [],
      callPolicy: 'all',
      allowedCallerAgentIds: [],
      outboundPolicy: 'all',
      allowedTargetAgentIds: [],
      introduceOnJoin: false,
      runInSandbox: false,
      lastModifiedAt: new Date('2026-01-01T00:00:00Z'),
      lastModifiedBy: null,
      configRevision: 0n
    }

    // The bug: these were omitted when null, conflating "cleared to default" with
    // "leave alone", so the previous runtime's model survived in agent.json. They must
    // be present-and-null (like env/mcpServers) so the daemon merge deletes them.
    const spec = agentRecordToSpec(base, {})
    expect(spec).toHaveProperty('model', null)
    expect(spec).toHaveProperty('reasoningEffort', null)
    expect(spec).toHaveProperty('permissionMode', null)

    // A set value still rides through unchanged.
    expect(agentRecordToSpec({ ...base, model: 'opus' }, {})).toMatchObject({ model: 'opus' })
  })

  it('ships the caller-fetched secrets (AgentSecretStore) on the spec — even {} so a removed secret replicates', () => {
    const base: AgentRecord = {
      id: AgentId('77777777-7777-4777-8777-777777777777'),
      orgId: OrgId('org'),
      name: 'deploy-bot',
      displayName: 'Deploy Bot',
      builtin: false,
      icon: null,
      description: null,
      runtime: 'claude-acp',
      model: null,
      reasoningEffort: null,
      outputMode: null,
      showFooter: true,
      showStatusBar: false,
      fastMode: null,
      permissionMode: null,
      allowRuntimeChangesInChat: false,
      pause: null,
      env: {},
      mcpServers: [],
      skills: [],
      managedSkills: [],
      memory: null,
      status: 'active',
      placementKind: 'daemon',
      daemonId: null,
      setId: null,
      workspace: { mode: 'scratch' },
      capabilities: [],
      createdAt: new Date('2026-01-01T00:00:00Z'),
      createdBy: null,
      createdByUserId: null,
      visibility: 'org',
      sharedWith: [],
      callPolicy: 'all',
      allowedCallerAgentIds: [],
      outboundPolicy: 'all',
      allowedTargetAgentIds: [],
      introduceOnJoin: false,
      runInSandbox: false,
      lastModifiedAt: new Date('2026-01-01T00:00:00Z'),
      lastModifiedBy: null,
      configRevision: 0n
    }

    expect(agentRecordToSpec(base, { API_KEY: 'sk-1' })).toMatchObject({ secrets: { API_KEY: 'sk-1' } })
    expect(agentRecordToSpec(base, {})).toMatchObject({ secrets: {} })
  })
})

describe('gatesNewConversations (resource-visibility §14 × the §5 manifest)', () => {
  const restricted = { visibility: 'restricted' } as Pick<AgentRecord, 'visibility'>
  const org = { visibility: 'org' } as Pick<AgentRecord, 'visibility'>

  it('starts a restricted agent’s fresh conversations Off on every ordinary platform', () => {
    for (const p of ['slack', 'telegram', 'discord', 'feishu', 'some-future-platform'])
      expect(gatesNewConversations(p, restricted), p).toBe(true)
  })

  it('never gates a conversation on Linear, where the install IS the consent', () => {
    // Linking an agent to a workspace is the act of enabling it there, and the workspace is the
    // only conversation — so a restricted agent's row is born enabled like any other.
    expect(gatesNewConversations('linear', restricted)).toBe(false)
  })

  it('gates nothing for a non-restricted agent, whatever the platform', () => {
    for (const p of ['slack', 'linear', 'some-future-platform']) expect(gatesNewConversations(p, org), p).toBe(false)
  })
})
