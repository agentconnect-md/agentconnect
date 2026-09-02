/**
 * Feishu / Lark CpPlatformProvider (§9, S3) — unit, no I/O.
 *
 * The load-bearing suites are the EQUIVALENCE blocks. Now that the live paths
 * (`integrationToSpec` / `httpIntegrationToSpec` in `orchestrator/placement.ts`
 * and `buildAssign` in `orchestrator/httpBot.ts`) go THROUGH this provider,
 * comparing their output to the provider's would prove nothing — so the pins are
 * GOLDEN LITERALS of the payloads the pre-adoption per-platform arms emitted,
 * plus, across the input permutations, equality with the extracted helper bodies
 * those arms called (unchanged by the flip), which is what catches core
 * threading the wrong envelope, secret, or bot row into the seam. The
 * `projectBotAssign` block still runs the REAL orchestrator (in-memory repos, a
 * recording relay channel) so the frame captured off the wire is the live one.
 */
import { describe, it, expect, vi } from 'vitest'
import type { FastifyPluginAsync } from 'fastify'
import {
  createFeishuCpProvider,
  feishuBotAssignBags,
  feishuIntegrationConfig,
  feishuSharedIntegrationConfig,
  refineFeishuCreateBody,
  FeishuCreateCredentials,
  FeishuCpEnvSchema,
  FEISHU_REGISTRATION_TTL_MS
} from './provider.js'
import { integrationToSpec, httpIntegrationToSpec } from '../../orchestrator/placement.js'
import { HttpBotOrchestrator } from '../../orchestrator/httpBot.js'
import { AgentDelivery } from '../../orchestrator/agentDelivery.js'
import { RelayRegistry, type RelayChannel } from '../../ws/relay-registry.js'
import { buildCreateIntegrationBody } from '../../http/dto/create-integration-body.js'
import { buildCpPlatformRegistry } from '../registry.js'
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
const validationProvider = (deps: Parameters<typeof createFeishuCpProvider>[0] = {}) =>
  createFeishuCpProvider({
    tenantGuard: { loginAppStatus: async () => 'ok', checkApp: async () => 'ok' },
    ...deps
  })

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
    grantedScopes: null,
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

// §9 adoption: the live spec/assign paths reach this provider THROUGH the
// registry, so the equivalence suites below drive the real registry rather than
// calling the provider beside the live path.
const PLATFORMS = buildCpPlatformRegistry([createFeishuCpProvider({ verifyBot: verifierOk() })])

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

  it('declares the regional Login App credentials used as the tenant anchor', () => {
    expect(provider.envSchema).toBe(FeishuCpEnvSchema)
    expect(Object.keys(provider.envSchema!)).toEqual([
      'FEISHU_PLATFORM_APP_ID',
      'FEISHU_PLATFORM_APP_SECRET',
      'LARK_PLATFORM_APP_ID',
      'LARK_PLATFORM_APP_SECRET'
    ])
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
    // The live body is COMPOSED from the registry (§9), so the rule reaches the
    // DTO through the provider's `refineCreateBody` — no second copy anywhere.
    const CreateIntegrationBody = buildCreateIntegrationBody(buildCpPlatformRegistry([createFeishuCpProvider({})]))
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
    const checkApp = vi.fn(async () => 'ok' as const)
    const provider = validationProvider({
      verifyBot,
      tenantGuard: { loginAppStatus: async () => 'ok', checkApp }
    })
    const result = await provider.validateConfig(CREDS, 'socket')
    expect(verifyBot).toHaveBeenCalledWith('cli_testapp', 'feishu-app-secret', 'lark')
    expect(checkApp).toHaveBeenCalledWith('cli_testapp', 'feishu-app-secret', 'lark')
    expect(result).toEqual({
      ok: true,
      identity: { name: 'helper-app', externalAppId: 'cli_testapp', botUserId: 'ou_bot' }
    })
  })

  it('refuses rejected credentials with the route’s 400 copy', async () => {
    const provider = validationProvider({ verifyBot: vi.fn(async () => ({ status: 'invalid' as const })) })
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
    const noOpenId = validationProvider({ verifyBot: verifierOk({ openId: null }) })
    expect(await noOpenId.validateConfig(CREDS, 'http')).toEqual(refusal)
    const unreachable = validationProvider({ verifyBot: vi.fn(async () => ({ status: 'unreachable' as const })) })
    expect(await unreachable.validateConfig(CREDS, 'http')).toEqual(refusal)
    const unverified = validationProvider()
    expect(await unverified.validateConfig(CREDS, 'http')).toEqual(refusal)
  })

  it('socket transport stays best-effort about reachability (route parity)', async () => {
    const unreachable = validationProvider({ verifyBot: vi.fn(async () => ({ status: 'unreachable' as const })) })
    expect(await unreachable.validateConfig(CREDS, 'socket')).toEqual({
      ok: true,
      identity: { externalAppId: 'cli_testapp' }
    })
    const unverified = validationProvider()
    expect(await unverified.validateConfig(CREDS, 'socket')).toEqual({
      ok: true,
      identity: { externalAppId: 'cli_testapp' }
    })
  })

  it('rejects an App from a different deployment organization', async () => {
    const provider = validationProvider({
      verifyBot: verifierOk(),
      tenantGuard: { loginAppStatus: async () => 'ok', checkApp: async () => 'org_mismatch' }
    })
    expect(await provider.validateConfig(CREDS, 'socket')).toEqual({
      ok: false,
      status: 400,
      code: 'FEISHU_ORG_MISMATCH',
      message: 'This Bot App belongs to a different Lark/Feishu organization from this AgentConnect deployment.'
    })
  })

  it('fails closed when this deployment has no matching Login App configured', async () => {
    const provider = createFeishuCpProvider({ verifyBot: verifierOk() })
    expect(await provider.validateConfig(CREDS, 'socket')).toEqual({
      ok: false,
      status: 503,
      message: 'This AgentConnect deployment has no Lark/Feishu Login App configured for this region.'
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

  // GOLDEN: the literal payload the PRE-ADOPTION `integrationToSpec` feishu arm
  // emitted, including the two-slot overloading (appId ← the secret row's
  // `appToken` slot, appSecret ← its `botToken` slot) and the row's region.
  it('emits the byte-identical direct payload the pre-adoption feishu arm produced', async () => {
    const spec = await integrationToSpec(
      PLATFORMS,
      INTEGRATION,
      SOCKET_BOT,
      SOCKET_SECRET,
      [channel('oc_1', 'any'), channel('oc_2', 'mention'), channel('oc_3', 'off')],
      false
    )
    const bindRules = [
      { match: { kind: 'mention' } },
      { match: { kind: 'dm' } },
      { channel: 'oc_1', match: { kind: 'auto' } }
    ]
    expect(spec).toEqual({
      orgId: INTEGRATION.orgId,
      integrationId: INTEGRATION.id,
      agentId: INTEGRATION.agentId,
      platform: 'feishu',
      core: { mode: 'direct', bindRules, mutedChannels: ['oc_3'], gated: false },
      // §6.4 final shape: platform-private material ONLY — the routing knobs
      // and the ingress mode ride the core envelope, never the config payload.
      config: {
        appId: 'cli_testapp',
        appSecret: 'feishu-app-secret',
        region: 'lark'
      }
    })
  })

  it("defaults a legacy region-less row to 'feishu', exactly as the pre-adoption arm did", async () => {
    const spec = await integrationToSpec(PLATFORMS, LEGACY_INTEGRATION, SOCKET_BOT, SOCKET_SECRET, [], false)
    if (!spec) throw new Error('expected a deliverable spec')
    expect(spec.config).toMatchObject({ region: 'feishu' })
  })

  // Across the permutations the pin is the EXTRACTED helper — the unchanged body
  // the pre-adoption arm called.
  for (const { label, integration, channels, gated } of cases) {
    it(`routes the live path through the feishu projector unchanged — ${label}`, async () => {
      const spec = await integrationToSpec(PLATFORMS, integration, SOCKET_BOT, SOCKET_SECRET, channels, gated)
      if (!spec) throw new Error('expected a deliverable spec')
      expect(spec.core.mode).toBe('direct')
      expect(spec.config).toEqual(feishuIntegrationConfig(SOCKET_SECRET, integration))
      // The payload satisfies the daemon reader's wire schema (§6.4).
      expect(() => IntegrationFeishuConfig.parse(spec.config)).not.toThrow()
    })
  }
})

describe('feishu projection equivalence with the live httpIntegrationToSpec path (shared/http)', () => {
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

  // GOLDEN: the literal payload the PRE-ADOPTION `httpIntegrationToSpec` feishu
  // arm emitted. The daemon keeps the REST credentials for send/download; the
  // bot's own open_id rides as `botOpenId` so it can skip a `bot/info` call.
  it('emits the byte-identical shared payload the pre-adoption feishu arm produced', async () => {
    const httpBot = bot({ transport: 'http', botUserId: 'ou_bot' })
    const spec = await httpIntegrationToSpec(
      PLATFORMS,
      INTEGRATION,
      httpBot,
      HTTP_SECRET,
      [channel('oc_1', 'any'), channel('oc_2', 'off')],
      false
    )
    expect(spec).toEqual({
      orgId: INTEGRATION.orgId,
      integrationId: INTEGRATION.id,
      agentId: INTEGRATION.agentId,
      platform: 'feishu',
      // Ungated shared installs ship NO bindRules — the relay arbitrates.
      core: { mode: 'shared', bindRules: [], mutedChannels: ['oc_2'], gated: false },
      config: {
        appId: 'cli_testapp',
        appSecret: 'feishu-app-secret',
        botOpenId: 'ou_bot',
        region: 'lark'
      }
    })
  })

  for (const { label, bot: httpBot, channels, gated } of cases) {
    it(`routes the live path through the feishu projector unchanged — ${label}`, async () => {
      // The bot row is passed WHOLE now: `botUserId` is read off it by the
      // projector instead of being forwarded positionally by each call site.
      const spec = await httpIntegrationToSpec(PLATFORMS, INTEGRATION, httpBot, HTTP_SECRET, channels, gated)
      if (!spec) throw new Error('expected a deliverable spec')
      expect(spec.core.mode).toBe('shared')
      expect(spec.config).toEqual(
        feishuSharedIntegrationConfig(HTTP_SECRET, INTEGRATION, httpBot.botUserId ?? undefined)
      )
      expect(() => IntegrationFeishuConfig.parse(spec.config)).not.toThrow()
    })
  }
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
  const bots = { getUnscoped: async () => botRow, listHttpActive: async () => [botRow] }
  const orch = new HttpBotOrchestrator(
    bots as unknown as BotRepo,
    { get: async () => secret } as unknown as BotSecretStore,
    // Never reached by syncBot; present to satisfy the constructor.
    { install: async () => 1, revoke: async () => ({ applied: false, integrationIds: [] }) },
    { listForBot: async () => [integration] } as unknown as IntegrationRepo,
    { listForBot: async () => [] } as unknown as IntegrationChannelRepo,
    {
      getUnscoped: async () => ({ id: integration.agentId, name: 'alice', daemonId: 'd1', visibility: 'org' })
    } as unknown as AgentRepo,
    relayReg,
    { integrationUpsert: async () => {} } as never,
    { upsert: async () => {}, get: async () => null, listForBot: async () => [] } as unknown as ThreadAffinityStore,
    { findThreadOwner: async () => null } as unknown as SessionRepo,
    { info() {}, warn() {}, debug() {} },
    PLATFORMS,
    // No duty ledger ⇒ the spec goes to the placement alone, as this fixture expects.
    new AgentDelivery({ control: { integrationUpsert: async () => {} } as never, specs: undefined as never })
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
