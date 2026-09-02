/**
 * Discord CpPlatformProvider (§9, S3) — unit, no I/O.
 *
 * The load-bearing suite is the PROJECTION EQUIVALENCE block. Now that the live
 * spec assembly (`integrationToSpec`, `orchestrator/placement.ts`) goes THROUGH
 * this provider, comparing their output would prove nothing — so the pin is a
 * GOLDEN LITERAL of the payload the pre-adoption discord arm emitted, plus,
 * across the input permutations, equality with the extracted helper body that
 * arm called (unchanged by the flip).
 */
import { describe, it, expect, vi } from 'vitest'
import { createDiscordCpProvider, discordIntegrationConfig, DiscordCreateCredentials } from './provider.js'
import { integrationToSpec } from '../../orchestrator/placement.js'
import { buildCpPlatformRegistry } from '../registry.js'
import type { DiscordBotVerification, DiscordMessageContentIntentSetup } from '../../http/discord-identity.js'
import type { BotProfileIconAgent } from '../../http/bot-profile-icon.js'
import type { BotRecord, IntegrationChannelRecord, IntegrationRecord } from '../../persistence/ports.js'
import { AgentId, BotId, IntegrationId, OrgId } from '../../domain/ids.js'
import { IntegrationDiscordConfig } from '@agentconnect.md/protocol'

// A structurally valid Gateway token: first segment base64url-decodes to the
// 18-digit application id (`discordAppIdFromBotToken`'s contract).
const APP_ID = '123456789012345678'
const TOKEN_WITH_APP_ID = `${Buffer.from(APP_ID).toString('base64url')}.x.hmac`

const verifierOk = (name: string | null = 'helper-bot') =>
  vi.fn(async () => ({ status: 'ok', name }) as DiscordBotVerification)
const intent = (outcome: DiscordMessageContentIntentSetup = 'ready') => vi.fn(async () => outcome)

const INTEGRATION: IntegrationRecord = {
  id: IntegrationId('66666666-6666-4666-8666-666666666666'),
  orgId: OrgId('org'),
  agentId: AgentId('77777777-7777-4777-8777-777777777777'),
  botId: BotId('88888888-8888-4888-8888-888888888888'),
  platform: 'discord',
  name: 'helper-bot',
  status: 'active',
  createdAt: new Date('2026-01-01T00:00:00Z')
}

const BOT: BotRecord = {
  id: BotId('88888888-8888-4888-8888-888888888888'),
  orgId: OrgId('org'),
  platform: 'discord',
  name: 'helper-bot',
  prebuilt: false,
  slackAppId: null,
  teamId: null,
  workspaceId: null,
  workspaceName: null,
  botUserId: null,
  revokedAt: null,
  credentialRevision: 1,
  credentialInstalledAt: null,
  grantedScopes: null,
  externalAppId: null,
  externalTenantId: null,
  platformConfig: null,
  discordAppId: APP_ID,
  feishuAppId: null,
  feishuRegion: null,
  shareable: false,
  transport: 'socket',
  createdBy: null,
  lastUsedAt: null,
  lastAgentName: null,
  agentIds: [AgentId('77777777-7777-4777-8777-777777777777')],
  inUseByAgentId: AgentId('77777777-7777-4777-8777-777777777777'),
  createdAt: new Date('2026-01-01T00:00:00Z')
}

const SECRET = { botToken: TOKEN_WITH_APP_ID, appToken: null, signingSecret: null }

const AGENT: BotProfileIconAgent = { id: INTEGRATION.agentId, icon: null, runtime: 'claude' }

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
  icon: null,
  color: null,
  isPrivate: false,
  kind,
  trigger,
  dmUserId: null,
  triggerChosen: false,
  agentId: null
})

describe('discord provider identity + declarative facets', () => {
  const provider = createDiscordCpProvider({ verifyBot: verifierOk(), ensureMessageContentIntent: intent() })

  it('declares the discord platform id', () => {
    expect(provider.platformId).toBe('discord')
  })

  it('contributes no funnel routes at either mount scope', () => {
    expect(provider.installRoutes('org')).toEqual([])
    expect(provider.installRoutes('public-callback')).toEqual([])
  })

  it('accepts the token(+optional applicationId) block and rejects an empty token', () => {
    expect(provider.credentialBodySchema.parse({ botToken: 'tok' })).toEqual({ botToken: 'tok' })
    expect(provider.credentialBodySchema.parse({ botToken: 'tok', applicationId: APP_ID })).toEqual({
      botToken: 'tok',
      applicationId: APP_ID
    })
    expect(provider.credentialBodySchema.safeParse({ botToken: '' }).success).toBe(false)
    expect(provider.credentialBodySchema.safeParse({}).success).toBe(false)
  })

  it('re-exports the same schema instance the create DTO composes', () => {
    expect(provider.credentialBodySchema).toBe(DiscordCreateCredentials)
  })

  it('packs the single-slot secret row and gates no http assign', () => {
    expect(Object.keys(provider.secretShape.slots)).toEqual(['botToken'])
    expect(provider.secretShape.httpAssignRequires).toEqual([])
  })

  it('declares no funnel state, env keys, tooling credentials, or background loops', () => {
    expect(provider.pendingInstalls).toBeUndefined()
    expect(provider.envSchema).toBeUndefined()
    expect(provider.providerToolingCredentials).toBeUndefined()
    expect(provider.backgroundLoops).toBeUndefined()
  })

  it('declares no projectBotAssign — Discord has no HTTP callback ingress (S3 erratum)', () => {
    // The create route refuses `transport: 'http'` for discord, so no bot row
    // can reach core's assign builder; absence IS the "no relay path" signal.
    expect(provider.projectBotAssign).toBeUndefined()
  })
})

describe('discord validateConfig (route parity: integrations.ts discord arm)', () => {
  it('derives the bot name and decodes the application id from the token', async () => {
    const verifyBot = verifierOk()
    const ensure = intent('ready')
    const provider = createDiscordCpProvider({ verifyBot, ensureMessageContentIntent: ensure })
    const result = await provider.validateConfig({ botToken: TOKEN_WITH_APP_ID }, 'socket')
    expect(verifyBot).toHaveBeenCalledWith(TOKEN_WITH_APP_ID)
    expect(ensure).toHaveBeenCalledWith(TOKEN_WITH_APP_ID)
    expect(result).toEqual({ ok: true, identity: { name: 'helper-bot', externalAppId: APP_ID } })
  })

  it('omits identity fields it cannot derive (no name, unparseable token)', async () => {
    const provider = createDiscordCpProvider({ verifyBot: verifierOk(null), ensureMessageContentIntent: intent() })
    expect(await provider.validateConfig({ botToken: 'not-a-real-token' }, 'socket')).toEqual({
      ok: true,
      identity: {}
    })
  })

  it('refuses a definitive 401 with the route’s 400 copy (no machine code today)', async () => {
    const ensure = intent()
    const provider = createDiscordCpProvider({
      verifyBot: vi.fn(async () => ({ status: 'invalid' as const })),
      ensureMessageContentIntent: ensure
    })
    expect(await provider.validateConfig({ botToken: 'bad' }, 'socket')).toEqual({
      ok: false,
      status: 400,
      message:
        'Discord rejected the bot token — check you pasted the Bot token from the Developer Portal (Bot → Reset Token).'
    })
    // The route returns before the intent call — a rejected token must not
    // trigger a provider-state mutation.
    expect(ensure).not.toHaveBeenCalled()
  })

  it('skips token validation when no verifier is injected (route optionality)', async () => {
    const provider = createDiscordCpProvider({ ensureMessageContentIntent: intent() })
    expect(await provider.validateConfig({ botToken: TOKEN_WITH_APP_ID }, 'socket')).toEqual({
      ok: true,
      identity: { externalAppId: APP_ID }
    })
  })

  it('proceeds without a derived name when users/@me is unreachable (best-effort)', async () => {
    const provider = createDiscordCpProvider({
      verifyBot: vi.fn(async () => ({ status: 'unreachable' as const })),
      ensureMessageContentIntent: intent()
    })
    expect(await provider.validateConfig({ botToken: TOKEN_WITH_APP_ID }, 'socket')).toEqual({
      ok: true,
      identity: { externalAppId: APP_ID }
    })
  })

  it('refuses when the Message-Content intent flip is definitively rejected', async () => {
    const provider = createDiscordCpProvider({
      verifyBot: verifierOk(),
      ensureMessageContentIntent: intent('rejected')
    })
    expect(await provider.validateConfig({ botToken: TOKEN_WITH_APP_ID }, 'socket')).toEqual({
      ok: false,
      status: 400,
      code: 'DISCORD_MESSAGE_CONTENT_INTENT_SETUP_FAILED',
      message:
        'AgentConnect could not enable Message Content Intent automatically. Open the Discord Developer Portal → Bot → Privileged Gateway Intents, turn on Message Content Intent, save, then try again.'
    })
  })

  it('answers an unreachable intent check with 503, never proof of rejection', async () => {
    const provider = createDiscordCpProvider({
      verifyBot: verifierOk(),
      ensureMessageContentIntent: intent('unreachable')
    })
    expect(await provider.validateConfig({ botToken: TOKEN_WITH_APP_ID }, 'socket')).toEqual({
      ok: false,
      status: 503,
      code: 'DISCORD_MESSAGE_CONTENT_INTENT_CHECK_UNAVAILABLE',
      message:
        'AgentConnect could not reach Discord to check or enable Message Content Intent. Try installing again in a moment.'
    })
  })
})

describe('discord sideEffects (profile push delegation)', () => {
  it('delegates postCreate and ongoing icon sync to the injected syncer', async () => {
    const syncBotProfile = vi.fn(async () => {})
    const provider = createDiscordCpProvider({
      verifyBot: verifierOk(),
      ensureMessageContentIntent: intent(),
      syncBotProfile
    })
    await provider.sideEffects?.postCreate?.({ integration: INTEGRATION, bot: BOT, secrets: SECRET, agent: AGENT })
    expect(syncBotProfile).toHaveBeenNthCalledWith(1, SECRET.botToken, AGENT)
    await provider.sideEffects?.syncBotProfileIcon?.(BOT, SECRET, AGENT)
    expect(syncBotProfile).toHaveBeenNthCalledWith(2, SECRET.botToken, AGENT)
  })

  it('reports no icon capability when the syncer is absent (member presence is the probe)', () => {
    const provider = createDiscordCpProvider({ verifyBot: verifierOk(), ensureMessageContentIntent: intent() })
    expect(provider.sideEffects).toBeUndefined()
  })
})

// §9 adoption: the live spec path reaches this provider THROUGH the registry, so
// the equivalence suite below drives the real registry rather than calling the
// provider beside the live path.
const PLATFORMS = buildCpPlatformRegistry([
  createDiscordCpProvider({ verifyBot: verifierOk(), ensureMessageContentIntent: intent() })
])

describe('discord projection equivalence with the live integrationToSpec path', () => {
  const cases: Array<{ label: string; channels: IntegrationChannelRecord[]; gated: boolean }> = [
    { label: 'defaults (no channels)', channels: [], gated: false },
    {
      label: "ungated with 'any' + muted channels",
      channels: [channel('C1', 'any'), channel('C2', 'mention'), channel('C3', 'off'), channel('D1', 'off', 'im')],
      gated: false
    },
    {
      label: 'gated conversation-scoped rules',
      channels: [channel('C1', 'any'), channel('C2', 'mention'), channel('C3', 'off'), channel('D1', 'any', 'im')],
      gated: true
    }
  ]

  // GOLDEN: the literal payload the PRE-ADOPTION `integrationToSpec` discord arm
  // emitted — the Gateway authenticates with the single bot token (no appToken).
  it('emits the byte-identical payload the pre-adoption discord arm produced', async () => {
    const spec = await integrationToSpec(
      PLATFORMS,
      INTEGRATION,
      BOT,
      SECRET,
      [channel('C1', 'any'), channel('C2', 'mention'), channel('C3', 'off')],
      false
    )
    const bindRules = [
      { match: { kind: 'mention' } },
      { match: { kind: 'dm' } },
      { channel: 'C1', match: { kind: 'auto' } }
    ]
    expect(spec).toEqual({
      orgId: INTEGRATION.orgId,
      integrationId: INTEGRATION.id,
      agentId: INTEGRATION.agentId,
      platform: 'discord',
      core: { mode: 'direct', bindRules, mutedChannels: ['C3'], gated: false },
      // §6.4 final shape: platform-private material ONLY — the routing knobs
      // ride the core envelope, never the config payload.
      config: { botToken: TOKEN_WITH_APP_ID }
    })
  })

  // Across the permutations the pin is the EXTRACTED helper — the unchanged body
  // the pre-adoption arm called.
  for (const { label, channels, gated } of cases) {
    it(`routes the live path through the discord projector unchanged — ${label}`, async () => {
      const spec = await integrationToSpec(PLATFORMS, INTEGRATION, BOT, SECRET, channels, gated)
      if (!spec) throw new Error('expected a deliverable spec')
      expect(spec.core.mode).toBe('direct')
      expect(spec.config).toEqual(discordIntegrationConfig(SECRET))
      // The payload satisfies the daemon reader's wire schema (§6.4).
      expect(() => IntegrationDiscordConfig.parse(spec.config)).not.toThrow()
    })
  }

  // §9 erratum: no `projectBotAssign`, so an http-transport discord bot has no
  // relay path at all — the create route refuses that transport on exactly this
  // signal, which is why the assign builder never sees one.
  it('contributes a spec projector but no relay assign projector', () => {
    const provider = createDiscordCpProvider({ verifyBot: verifierOk(), ensureMessageContentIntent: intent() })
    expect(typeof provider.projectIntegrationConfig).toBe('function')
    expect(provider.projectBotAssign).toBeUndefined()
  })
})
