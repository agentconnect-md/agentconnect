/**
 * Telegram CpPlatformProvider (§9, S3) — unit, no I/O.
 *
 * The load-bearing suite is the PROJECTION EQUIVALENCE block: while the live
 * spec assembly is still `integrationToSpec` (`orchestrator/placement.ts`),
 * the provider's `projectIntegrationConfig` must produce EXACTLY the `config`
 * payload that path emits for the same inputs — that equality is what makes
 * the eventual call-site flip a zero-behavior change.
 */
import { describe, it, expect, vi } from 'vitest'
import { createTelegramCpProvider, telegramIntegrationConfig, TelegramCreateCredentials } from './provider.js'
import { integrationToSpec } from '../../orchestrator/placement.js'
import type { TelegramBotVerification } from '../../http/telegram-identity.js'
import type { BotProfileIconAgent } from '../../http/bot-profile-icon.js'
import type { BotRecord, IntegrationChannelRecord, IntegrationRecord } from '../../persistence/ports.js'
import { AgentId, BotId, IntegrationId, OrgId } from '../../domain/ids.js'
import { IntegrationTelegramConfig } from '@agentconnect.md/protocol'

const verifierOk = (over: Partial<Extract<TelegramBotVerification, { status: 'ok' }>> = {}) =>
  vi.fn(
    async () => ({ status: 'ok', name: 'helper_bot', privacyModeDisabled: true, ...over }) as TelegramBotVerification
  )

const INTEGRATION: IntegrationRecord = {
  id: IntegrationId('66666666-6666-4666-8666-666666666666'),
  orgId: OrgId('org'),
  agentId: AgentId('77777777-7777-4777-8777-777777777777'),
  botId: BotId('88888888-8888-4888-8888-888888888888'),
  platform: 'telegram',
  name: 'helper-bot',
  status: 'active',
  createdAt: new Date('2026-01-01T00:00:00Z')
}

const BOT: BotRecord = {
  id: BotId('88888888-8888-4888-8888-888888888888'),
  orgId: OrgId('org'),
  platform: 'telegram',
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
  externalAppId: null,
  externalTenantId: null,
  platformConfig: null,
  discordAppId: null,
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

const SECRET = { botToken: '123456:ABC-tg-token', appToken: null, signingSecret: null }

const AGENT: BotProfileIconAgent = { id: INTEGRATION.agentId, icon: null, runtime: 'claude' }

const channel = (
  channelId: string,
  trigger: 'off' | 'mention' | 'any',
  kind: 'channel' | 'im' | 'mpim' = 'channel'
): IntegrationChannelRecord => ({
  integrationId: INTEGRATION.id,
  channelId,
  name: channelId.toLowerCase(),
  isPrivate: false,
  kind,
  trigger,
  agentId: null
})

describe('telegram provider identity + declarative facets', () => {
  const provider = createTelegramCpProvider({ verifyBot: verifierOk() })

  it('declares the telegram platform id', () => {
    expect(provider.platformId).toBe('telegram')
  })

  it('contributes no funnel routes at either mount scope', () => {
    expect(provider.installRoutes('org')).toEqual([])
    expect(provider.installRoutes('public-callback')).toEqual([])
  })

  it('accepts the single-token credential block and rejects an empty one', () => {
    expect(provider.credentialBodySchema.parse({ botToken: '123456:abc' })).toEqual({ botToken: '123456:abc' })
    expect(provider.credentialBodySchema.safeParse({ botToken: '' }).success).toBe(false)
    expect(provider.credentialBodySchema.safeParse({}).success).toBe(false)
  })

  it('re-exports the same schema instance the create DTO composes', () => {
    expect(provider.credentialBodySchema).toBe(TelegramCreateCredentials)
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
})

describe('telegram validateConfig (route parity: integrations.ts telegram arm)', () => {
  it('passes the pasted token to the verifier and derives the bot name', async () => {
    const verifyBot = verifierOk()
    const provider = createTelegramCpProvider({ verifyBot })
    const result = await provider.validateConfig({ botToken: '123456:abc' }, 'socket')
    expect(verifyBot).toHaveBeenCalledWith('123456:abc')
    expect(result).toEqual({ ok: true, identity: { name: 'helper_bot' } })
  })

  it('omits the name when getMe returns none', async () => {
    const provider = createTelegramCpProvider({ verifyBot: verifierOk({ name: null }) })
    const result = await provider.validateConfig({ botToken: '123456:abc' }, 'socket')
    expect(result).toEqual({ ok: true, identity: {} })
  })

  it('refuses a definitive rejection with the route’s 400 + code + copy', async () => {
    const provider = createTelegramCpProvider({ verifyBot: vi.fn(async () => ({ status: 'invalid' as const })) })
    expect(await provider.validateConfig({ botToken: '123456:bad' }, 'socket')).toEqual({
      ok: false,
      status: 400,
      code: 'TELEGRAM_BOT_TOKEN_INVALID',
      message: 'Telegram rejected the bot token — copy it again from @BotFather.'
    })
  })

  it('answers an unreachable Telegram with 503, never proof the token is bad', async () => {
    const provider = createTelegramCpProvider({ verifyBot: vi.fn(async () => ({ status: 'unreachable' as const })) })
    expect(await provider.validateConfig({ botToken: '123456:abc' }, 'socket')).toEqual({
      ok: false,
      status: 503,
      code: 'TELEGRAM_BOT_CHECK_UNAVAILABLE',
      message: 'AgentConnect could not reach Telegram to check this bot. Try again in a moment.'
    })
  })

  it('refuses while Group Privacy Mode is still enabled', async () => {
    const provider = createTelegramCpProvider({ verifyBot: verifierOk({ privacyModeDisabled: false }) })
    expect(await provider.validateConfig({ botToken: '123456:abc' }, 'socket')).toEqual({
      ok: false,
      status: 400,
      code: 'TELEGRAM_PRIVACY_MODE_ENABLED',
      message:
        'Privacy Mode is still on. In @BotFather, send /setprivacy, select this bot, choose Disable, then try again.'
    })
  })
})

describe('telegram sideEffects (icon push delegation)', () => {
  it('delegates postCreate and ongoing icon sync to the injected syncer', async () => {
    const syncBotIcon = vi.fn(async () => {})
    const provider = createTelegramCpProvider({ verifyBot: verifierOk(), syncBotIcon })
    await provider.sideEffects?.postCreate?.({ integration: INTEGRATION, bot: BOT, secrets: SECRET, agent: AGENT })
    expect(syncBotIcon).toHaveBeenNthCalledWith(1, SECRET.botToken, AGENT)
    await provider.sideEffects?.syncBotProfileIcon?.(BOT, SECRET, AGENT)
    expect(syncBotIcon).toHaveBeenNthCalledWith(2, SECRET.botToken, AGENT)
  })

  it('reports no icon capability when the syncer is absent (member presence is the probe)', () => {
    const provider = createTelegramCpProvider({ verifyBot: verifierOk() })
    expect(provider.sideEffects).toBeUndefined()
  })
})

describe('telegram projection equivalence with the live integrationToSpec path', () => {
  const provider = createTelegramCpProvider({ verifyBot: verifierOk() })

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

  for (const { label, channels, gated } of cases) {
    it(`emits exactly the live path's config — ${label}`, async () => {
      const spec = integrationToSpec(INTEGRATION, SECRET, channels, gated)
      const projected = await provider.projectIntegrationConfig(INTEGRATION, BOT, spec.core!, SECRET)
      expect(projected).toEqual(spec.config)
      // Both sides satisfy the daemon reader's wire schema (§6.4).
      expect(IntegrationTelegramConfig.parse(projected)).toEqual(IntegrationTelegramConfig.parse(spec.config))
    })
  }

  it('shares one implementation with placement.ts (the extracted helper)', () => {
    const spec = integrationToSpec(INTEGRATION, SECRET, [channel('C1', 'any')], false)
    expect(telegramIntegrationConfig(spec.core!, SECRET)).toEqual(spec.config)
  })
})

describe('telegram projectBotAssign (no HTTP ingress)', () => {
  it('refuses: the create route never mints an http-transport telegram bot', async () => {
    const provider = createTelegramCpProvider({ verifyBot: verifierOk() })
    await expect(provider.projectBotAssign(BOT, SECRET)).rejects.toThrow(/no HTTP callback ingress/)
  })
})
