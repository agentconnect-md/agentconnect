/**
 * Feishu / Lark CpPlatformProvider (§9, S3) — unit, no I/O.
 *
 * The load-bearing suites are the EQUIVALENCE blocks: while the live paths are
 * still `integrationToSpec` / `httpIntegrationToSpec`
 * (`orchestrator/placement.ts`) and `buildAssign` (`orchestrator/httpBot.ts`),
 * the provider's `projectIntegrationConfig` / `projectBotAssign` must produce
 * EXACTLY the payloads those paths emit for the same inputs — that equality is
 * what makes the eventual call-site flip a zero-behavior change. The
 * `projectBotAssign` block runs the REAL orchestrator (in-memory repos, a
 * recording relay channel) and compares the live `rc/bot-assign` frame's two
 * opaque bags against the provider's projection.
 */
import { describe, it, expect, vi } from 'vitest'
import type { FastifyPluginAsync } from 'fastify'
import {
  createFeishuCpProvider,
  feishuBotAssignBags,
  feishuIntegrationConfig,
  feishuSharedIntegrationConfig,
  refineFeishuCreateBody,
  FeishuCpEnvSchema,
  FeishuCreateCredentials,
  FEISHU_REGISTRATION_TTL_MS
} from './provider.js'
import { integrationToSpec, httpIntegrationToSpec } from '../../orchestrator/placement.js'
import { HttpBotOrchestrator } from '../../orchestrator/httpBot.js'
import { RelayRegistry, type RelayChannel } from '../../ws/relay-registry.js'
import { CreateIntegrationBody } from '../../http/dto/index.js'
import { AppConfigSchema } from '../../config/env.js'
import type { FeishuBotVerification } from '../../http/feishu-identity.js'
import type { BotProfileIconAgent } from '../../http/bot-profile-icon.js'
import type {
  AgentRepo,
  BotRepo,
  BotRecord,
  BotSecretMaterial,
  BotSecretStore,
  IntegrationChannelRepo,
  IntegrationChannelRecord,
  IntegrationRecord,
  IntegrationRepo,
  SessionRepo,
  ThreadAffinityStore
} from '../../persistence/ports.js'
import { AgentId, BotId, IntegrationId, OrgId } from '../../domain/ids.js'
import { IntegrationFeishuConfig, type RcBotAssign, type RelayCpFrameType } from '@agentconnect.md/protocol'

const verifierOk = (over: Partial<Extract<FeishuBotVerification, { status: 'ok' }>> = {}) =>
  vi.fn(async () => ({ status: 'ok', name: 'helper-app', openId: 'ou_bot', ...over }) as FeishuBotVerification)

const ORG = OrgId('11111111-1111-4111-8111-111111111111')
const AGENT_ID = AgentId('77777777-7777-4777-8777-777777777777')

const INTEGRATION: IntegrationRecord = {
  id: IntegrationId('66666666-6666-4666-8666-666666666666'),
  orgId: ORG,
  agentId: AGENT_ID,
  botId: BotId('88888888-8888-4888-8888-888888888888'),
  platform: 'feishu',
  name: 'helper-app',
  status: 'active',
  feishuRegion: 'lark',
  createdAt: new Date('2026-01-01T00:00:00Z')
}

/** A legacy row without the region column — the helpers' 'feishu' default arm. */
const LEGACY_INTEGRATION: IntegrationRecord = {
  id: INTEGRATION.id,
  orgId: INTEGRATION.orgId,
  agentId: INTEGRATION.agentId,
  botId: INTEGRATION.botId,
  platform: 'feishu',
  name: INTEGRATION.name,
  status: 'active',
  createdAt: INTEGRATION.createdAt
}

function bot(over: Partial<BotRecord> = {}): BotRecord {
  return {
    id: BotId('88888888-8888-4888-8888-888888888888'),
    orgId: ORG,
    platform: 'feishu',
    name: 'helper-app',
    prebuilt: false,
    slackAppId: null,
    teamId: null,
    workspaceId: null,
    workspaceName: null,
    botUserId: null,
    revokedAt: null,
    credentialRevision: 1,
    credentialInstalledAt: null,
    externalAppId: 'cli_testapp',
    externalTenantId: '-',
    platformConfig: null,
    discordAppId: null,
    feishuAppId: 'cli_testapp',
    feishuRegion: 'lark',
    shareable: false,
    transport: 'socket',
    createdBy: null,
    lastUsedAt: null,
    lastAgentName: null,
    agentIds: [AGENT_ID],
    inUseByAgentId: AGENT_ID,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over
  }
}

// The two-slot overloading: botToken = app SECRET, appToken = app ID. The
// callback credentials ride the optional slots (http installs only).
const SOCKET_SECRET: BotSecretMaterial = {
  botToken: 'feishu-app-secret',
  appToken: 'cli_testapp',
  signingSecret: null
}
const HTTP_SECRET: BotSecretMaterial = {
  botToken: 'feishu-app-secret',
  appToken: 'cli_testapp',
  signingSecret: null,
  verificationToken: 'verify-token',
  encryptKey: 'encrypt-key'
}

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

describe('feishu provider identity + declarative facets', () => {
  const provider = createFeishuCpProvider({ verifyBot: verifierOk() })

  it('declares the feishu platform id', () => {
    expect(provider.platformId).toBe('feishu')
  })

  it('hands out the injected funnel plugin at org scope only, empty when uncomposed', () => {
    expect(provider.installRoutes('org')).toEqual([])
    expect(provider.installRoutes('public-callback')).toEqual([])
    // One org-scoped registration funnel; the device flow polls server-side,
    // so there is no browser OAuth callback at the version root.
    const org = [vi.fn()] as unknown as FastifyPluginAsync[]
    const composed = createFeishuCpProvider({ funnelRoutes: { org, publicCallback: [] } })
    expect(composed.installRoutes('org')).toEqual(org)
    expect(composed.installRoutes('public-callback')).toEqual([])
  })

  it('re-exports the same credential schema instance the create DTO composes', () => {
    expect(provider.credentialBodySchema).toBe(FeishuCreateCredentials)
    // The region defaults to international Lark for new create requests.
    expect(provider.credentialBodySchema.parse({ appId: 'cli_x', appSecret: 's' })).toEqual({
      appId: 'cli_x',
      appSecret: 's',
      region: 'lark'
    })
    expect(provider.credentialBodySchema.safeParse({ appId: 'cli_x' }).success).toBe(false)
  })

  it('packs the overloaded secret row and gates http assigns on verificationToken + appToken', () => {
    expect(Object.keys(provider.secretShape.slots)).toEqual(['botToken', 'appToken', 'verificationToken', 'encryptKey'])
    // The gate `HttpBotOrchestrator.syncBot` / `replayTo` apply before building
    // an assign for a feishu bot.
    expect(provider.secretShape.httpAssignRequires).toEqual(['verificationToken', 'appToken'])
  })

  it('owns the FEISHU/LARK_PLATFORM_* env keys, spread into AppConfigSchema', () => {
    expect(provider.envSchema).toBe(FeishuCpEnvSchema)
    expect(Object.keys(FeishuCpEnvSchema)).toEqual([
      'FEISHU_PLATFORM_APP_ID',
      'FEISHU_PLATFORM_APP_SECRET',
      'LARK_PLATFORM_APP_ID',
      'LARK_PLATFORM_APP_SECRET'
    ])
    // One implementation: the live config schema is composed FROM this shape.
    for (const key of Object.keys(FeishuCpEnvSchema)) {
      expect(AppConfigSchema.shape[key as keyof typeof AppConfigSchema.shape]).toBe(
        FeishuCpEnvSchema[key as keyof typeof FeishuCpEnvSchema]
      )
    }
  })

  it('declares the registration funnel from the injected store + the 10-minute constant TTL', () => {
    const registrations = { reapExpired: vi.fn(async () => 0) }
    const composed = createFeishuCpProvider({ pendingInstalls: { registrations, intervalMs: 600_000 } })
    expect(composed.pendingInstalls).toEqual([
      {
        model: 'FeishuAppRegistration',
        label: 'feishu-registration',
        store: registrations,
        ttlMs: FEISHU_REGISTRATION_TTL_MS,
        intervalMs: 600_000
      }
    ])
    expect(FEISHU_REGISTRATION_TTL_MS).toBe(10 * 60 * 1000)
    expect(provider.pendingInstalls).toBeUndefined() // uncomposed ⇒ undeclared
  })

  it('declares no tooling credentials and no background loops', () => {
    expect(provider.providerToolingCredentials).toBeUndefined()
    expect(provider.backgroundLoops).toBeUndefined()
  })

  it('implements projectBotAssign — Feishu has an HTTP/relay path (S3 erratum)', () => {
    expect(typeof provider.projectBotAssign).toBe('function')
  })
})

describe('feishu refineCreateBody (DTO parity: the create body superRefine feishu arm)', () => {
  const creds = FeishuCreateCredentials.parse({ appId: 'cli_x', appSecret: 's' })
  const issues = (body: { credentials: FeishuCreateCredentials; transport: 'socket' | 'http' }) => {
    const out: string[] = []
    refineFeishuCreateBody(body, (message) => out.push(message))
    return out
  }

  it('requires the verification token for http only; encryptKey stays optional', () => {
    expect(issues({ credentials: creds, transport: 'http' })).toEqual([
      'http transport requires feishu.verificationToken'
    ])
    expect(issues({ credentials: creds, transport: 'socket' })).toEqual([])
    expect(issues({ credentials: { ...creds, verificationToken: 'v' }, transport: 'http' })).toEqual([])
  })

  it('is the same rule the live create DTO enforces (one implementation)', () => {
    const base = { platform: 'feishu', agentId: AGENT_ID as string }
    const http = CreateIntegrationBody.safeParse({
      ...base,
      transport: 'http',
      feishu: { appId: 'cli_x', appSecret: 's' }
    })
    expect(http.success).toBe(false)
    expect(http.error?.issues.map((i) => i.message)).toContain('http transport requires feishu.verificationToken')
    // Socket (and the create route's omitted-transport default) needs no
    // callback credentials.
    expect(CreateIntegrationBody.safeParse({ ...base, feishu: { appId: 'cli_x', appSecret: 's' } }).success).toBe(true)
  })
})

describe('feishu validateConfig (route parity: integrations.ts feishu arm)', () => {
  const CREDS = FeishuCreateCredentials.parse({ appId: 'cli_testapp', appSecret: 'feishu-app-secret' })

  it('passes the pasted pair + region to the verifier and derives name/openId', async () => {
    const verifyBot = verifierOk()
    const provider = createFeishuCpProvider({ verifyBot })
    const result = await provider.validateConfig(CREDS, 'socket')
    expect(verifyBot).toHaveBeenCalledWith('cli_testapp', 'feishu-app-secret', 'lark')
    expect(result).toEqual({
      ok: true,
      identity: { name: 'helper-app', externalAppId: 'cli_testapp', botUserId: 'ou_bot' }
    })
  })

  it('refuses rejected credentials with the route’s 400 copy', async () => {
    const provider = createFeishuCpProvider({ verifyBot: vi.fn(async () => ({ status: 'invalid' as const })) })
    expect(await provider.validateConfig(CREDS, 'socket')).toEqual({
      ok: false,
      status: 400,
      message:
        'Feishu rejected the credentials — check the App ID (cli_…) and App Secret from the Developer Console (Credentials & Basic Info).'
    })
  })

  it('http transport requires a resolved bot open_id — inconclusive is the route’s 503, never a 400', async () => {
    const refusal = {
      ok: false,
      status: 503,
      message: 'Could not resolve this app’s bot identity. Enable the bot capability in Feishu, then try again.'
    }
    const noOpenId = createFeishuCpProvider({ verifyBot: verifierOk({ openId: null }) })
    expect(await noOpenId.validateConfig(CREDS, 'http')).toEqual(refusal)
    const unreachable = createFeishuCpProvider({ verifyBot: vi.fn(async () => ({ status: 'unreachable' as const })) })
    expect(await unreachable.validateConfig(CREDS, 'http')).toEqual(refusal)
    const unverified = createFeishuCpProvider({})
    expect(await unverified.validateConfig(CREDS, 'http')).toEqual(refusal)
  })

  it('socket transport stays best-effort about reachability (route parity)', async () => {
    const unreachable = createFeishuCpProvider({ verifyBot: vi.fn(async () => ({ status: 'unreachable' as const })) })
    expect(await unreachable.validateConfig(CREDS, 'socket')).toEqual({
      ok: true,
      identity: { externalAppId: 'cli_testapp' }
    })
    const unverified = createFeishuCpProvider({})
    expect(await unverified.validateConfig(CREDS, 'socket')).toEqual({
      ok: true,
      identity: { externalAppId: 'cli_testapp' }
    })
  })
})

describe('feishu sideEffects (icon push delegation)', () => {
  const AGENT: BotProfileIconAgent = { id: AGENT_ID, icon: null, runtime: 'claude' }

  it('resolves the app id from the secret row and delegates to the injected syncer', async () => {
    const syncAppIcon = vi.fn(async () => {})
    const provider = createFeishuCpProvider({ verifyBot: verifierOk(), syncAppIcon })
    await provider.sideEffects?.syncBotProfileIcon?.(bot(), SOCKET_SECRET, AGENT)
    expect(syncAppIcon).toHaveBeenCalledWith('cli_testapp', 'feishu-app-secret', 'lark', AGENT)
  })

  it('falls back to the public bot metadata for older rows, and skips when neither exists', async () => {
    const syncAppIcon = vi.fn(async () => {})
    const provider = createFeishuCpProvider({ verifyBot: verifierOk(), syncAppIcon })
    // Older row: no appToken slot — the bot row's feishuAppId (+ its region default).
    const legacyBot = bot({ feishuAppId: 'cli_legacy', feishuRegion: null })
    const legacySecret: BotSecretMaterial = { botToken: 'feishu-app-secret', appToken: null, signingSecret: null }
    await provider.sideEffects?.syncBotProfileIcon?.(legacyBot, legacySecret, AGENT)
    expect(syncAppIcon).toHaveBeenCalledWith('cli_legacy', 'feishu-app-secret', 'feishu', AGENT)
    // No app id anywhere: cosmetic sync is skipped, never thrown.
    syncAppIcon.mockClear()
    await provider.sideEffects?.syncBotProfileIcon?.(bot({ feishuAppId: null }), legacySecret, AGENT)
    expect(syncAppIcon).not.toHaveBeenCalled()
  })

  it('declares no postCreate push (the create arm runs none) and no capability without a syncer', () => {
    const provider = createFeishuCpProvider({ verifyBot: verifierOk(), syncAppIcon: vi.fn(async () => {}) })
    expect(provider.sideEffects?.postCreate).toBeUndefined()
    expect(createFeishuCpProvider({ verifyBot: verifierOk() }).sideEffects).toBeUndefined()
  })
})

describe('feishu projection equivalence with the live integrationToSpec path (direct/socket)', () => {
  const provider = createFeishuCpProvider({ verifyBot: verifierOk() })
  const SOCKET_BOT = bot()

  const cases: Array<{
    label: string
    integration: IntegrationRecord
    channels: IntegrationChannelRecord[]
    gated: boolean
  }> = [
    { label: 'defaults (no channels)', integration: INTEGRATION, channels: [], gated: false },
    {
      label: "ungated with 'any' + muted channels",
      integration: INTEGRATION,
      channels: [channel('oc_1', 'any'), channel('oc_2', 'mention'), channel('oc_3', 'off')],
      gated: false
    },
    {
      label: 'gated conversation-scoped rules',
      integration: INTEGRATION,
      channels: [channel('oc_1', 'any'), channel('oc_2', 'off'), channel('om_1', 'any', 'im')],
      gated: true
    },
    {
      label: "legacy region-less row (region defaults to 'feishu')",
      integration: LEGACY_INTEGRATION,
      channels: [channel('oc_1', 'any')],
      gated: false
    }
  ]

  for (const { label, integration, channels, gated } of cases) {
    it(`emits exactly the live path's config — ${label}`, async () => {
      const spec = integrationToSpec(integration, SOCKET_SECRET, channels, gated)
      const projected = await provider.projectIntegrationConfig(integration, SOCKET_BOT, spec.core!, SOCKET_SECRET)
      expect(projected).toEqual(spec.config)
      // Both sides satisfy the daemon reader's wire schema (§6.4).
      expect(IntegrationFeishuConfig.parse(projected)).toEqual(IntegrationFeishuConfig.parse(spec.config))
    })
  }

  it('shares one implementation with placement.ts (the extracted helper)', () => {
    const spec = integrationToSpec(INTEGRATION, SOCKET_SECRET, [channel('oc_1', 'any')], false)
    expect(feishuIntegrationConfig(spec.core!, SOCKET_SECRET, INTEGRATION)).toEqual(spec.config)
  })
})

describe('feishu projection equivalence with the live httpIntegrationToSpec path (shared/http)', () => {
  const provider = createFeishuCpProvider({ verifyBot: verifierOk() })

  const cases: Array<{
    label: string
    bot: BotRecord
    channels: IntegrationChannelRecord[]
    gated: boolean
  }> = [
    {
      label: 'http bot with a resolved bot open_id',
      bot: bot({ transport: 'http', botUserId: 'ou_bot' }),
      channels: [channel('oc_1', 'any'), channel('oc_2', 'off')],
      gated: false
    },
    {
      label: 'legacy http bot without a persisted open_id',
      bot: bot({ transport: 'http' }),
      channels: [],
      gated: false
    },
    {
      label: 'gated member (conversation-scoped rules ride the send-only spec)',
      bot: bot({ transport: 'http', botUserId: 'ou_bot' }),
      channels: [channel('oc_1', 'mention'), channel('om_1', 'any', 'im'), channel('oc_2', 'off')],
      gated: true
    }
  ]

  for (const { label, bot: httpBot, channels, gated } of cases) {
    it(`emits exactly the live path's config — ${label}`, async () => {
      // The live call sites feed the bot row's fields positionally
      // (`placement.ts` reconcile, `httpBot.ts` pushSpecs).
      const spec = httpIntegrationToSpec(
        INTEGRATION,
        HTTP_SECRET,
        httpBot.shareable,
        channels,
        gated,
        httpBot.slackAppId ?? undefined,
        httpBot.botUserId ?? undefined
      )
      const projected = await provider.projectIntegrationConfig(INTEGRATION, httpBot, spec.core!, HTTP_SECRET)
      expect(projected).toEqual(spec.config)
      expect(IntegrationFeishuConfig.parse(projected)).toEqual(IntegrationFeishuConfig.parse(spec.config))
    })
  }

  it('shares one implementation with placement.ts (the extracted helper)', () => {
    const spec = httpIntegrationToSpec(INTEGRATION, HTTP_SECRET, false, [], false, undefined, 'ou_bot')
    expect(feishuSharedIntegrationConfig(spec.core!, HTTP_SECRET, INTEGRATION, 'ou_bot')).toEqual(spec.config)
  })
})

// ── projectBotAssign equivalence against the LIVE rc/bot-assign frame ────────
// A minimal real HttpBotOrchestrator: one placed member, no channels, one
// recording relay channel. `buildAssign` is private, so the frame captured off
// the wire IS the live path's output.
class FakeChannel implements RelayChannel {
  sends: { type: RelayCpFrameType; payload: unknown }[] = []
  constructor(readonly relayId: string) {}
  send(type: RelayCpFrameType, payload: unknown): void {
    this.sends.push({ type, payload })
  }
  close(): void {}
}

async function liveAssignFrame(botRow: BotRecord, secret: BotSecretMaterial): Promise<RcBotAssign> {
  const ch = new FakeChannel('relay-1')
  const relayReg = new RelayRegistry()
  relayReg.add(ch)
  const integration: IntegrationRecord = { ...INTEGRATION, botId: botRow.id }
  const bots = { get: async () => botRow, listHttpActive: async () => [botRow] }
  const orch = new HttpBotOrchestrator(
    bots as unknown as BotRepo,
    { get: async () => secret } as unknown as BotSecretStore,
    // Never reached by syncBot; present to satisfy the constructor.
    { install: async () => 1, revoke: async () => ({ applied: false, integrationIds: [] }) },
    { listForBot: async () => [integration] } as unknown as IntegrationRepo,
    { listForBot: async () => [] } as unknown as IntegrationChannelRepo,
    {
      get: async () => ({ id: integration.agentId, name: 'alice', daemonId: 'd1', visibility: 'org' })
    } as unknown as AgentRepo,
    relayReg,
    { integrationUpsert: async () => {} } as never,
    { upsert: async () => {}, get: async () => null, listForBot: async () => [] } as unknown as ThreadAffinityStore,
    { findThreadOwner: async () => null } as unknown as SessionRepo,
    { info() {}, warn() {}, debug() {} }
  )
  await orch.syncBot(botRow.id)
  const assign = ch.sends.find((s) => s.type === 'rc/bot-assign')?.payload as RcBotAssign | undefined
  if (!assign) throw new Error('live path built no rc/bot-assign for the fixture')
  return assign
}

describe('feishu projectBotAssign equivalence with the live buildAssign frame (§6.7)', () => {
  const provider = createFeishuCpProvider({ verifyBot: verifierOk() })

  it('http bot: verification credentials in the secrets bag, app id + open_id in the ingress bag', async () => {
    const httpBot = bot({ transport: 'http', botUserId: 'ou_bot' })
    const frame = await liveAssignFrame(httpBot, HTTP_SECRET)
    const projected = await provider.projectBotAssign!(httpBot, HTTP_SECRET)
    expect(projected.secrets).toEqual(frame.secrets)
    expect(projected.ingress).toEqual(frame.ingress)
    expect(projected).toEqual({
      secrets: { verificationToken: 'verify-token', encryptKey: 'encrypt-key' },
      ingress: { apiAppId: 'cli_testapp', botUserId: 'ou_bot' }
    })
    // The daemon-only app secret NEVER rides to the relay.
    expect(JSON.stringify(projected)).not.toContain('feishu-app-secret')
  })

  it('plaintext-events app (no encrypt key): the optional slot is omitted, not empty', async () => {
    const httpBot = bot({ transport: 'http' })
    const plaintextSecret: BotSecretMaterial = { ...HTTP_SECRET, encryptKey: null }
    const frame = await liveAssignFrame(httpBot, plaintextSecret)
    const projected = await provider.projectBotAssign!(httpBot, plaintextSecret)
    expect(projected.secrets).toEqual(frame.secrets)
    expect(projected.ingress).toEqual(frame.ingress)
    expect(projected).toEqual({
      secrets: { verificationToken: 'verify-token' },
      ingress: { apiAppId: 'cli_testapp' }
    })
  })

  it('shares one implementation with httpBot.ts (the extracted helper)', async () => {
    const httpBot = bot({ transport: 'http', botUserId: 'ou_bot' })
    const frame = await liveAssignFrame(httpBot, HTTP_SECRET)
    expect(feishuBotAssignBags(httpBot, HTTP_SECRET)).toEqual({
      secrets: frame.secrets,
      ingress: frame.ingress
    })
  })
})
