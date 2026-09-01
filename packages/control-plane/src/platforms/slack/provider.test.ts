/**
 * Slack CpPlatformProvider (§9, S3) — unit, no I/O.
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
  createSlackCpProvider,
  createSlackToolingCredentials,
  slackAppIdFromAppToken,
  slackBotAssignBags,
  slackIntegrationConfig,
  slackSharedIntegrationConfig,
  refineSlackCreateBody,
  SlackCpEnvSchema,
  SlackCreateCredentials
} from './provider.js'
import { integrationToSpec, httpIntegrationToSpec } from '../../orchestrator/placement.js'
import { SLACK_BOT_SCOPES } from '../../http/slack-manifest.js'
import { HttpBotOrchestrator } from '../../orchestrator/httpBot.js'
import { AgentDelivery } from '../../orchestrator/agentDelivery.js'
import { RelayRegistry, type RelayChannel } from '../../ws/relay-registry.js'
import { buildCreateIntegrationBody } from '../../http/dto/create-integration-body.js'
import { buildCpPlatformRegistry } from '../registry.js'
import { AppConfigSchema } from '../../config/env.js'
import type { SlackBotVerification } from '../../http/slack-identity.js'
import type { SlackUserConfigDeps } from '../../http/slack-user-config.js'
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
  SlackUserConfigRecord,
  ThreadAffinityStore
} from '../../persistence/ports.js'
import { AgentId, BotId, IntegrationId, OrgId } from '../../domain/ids.js'
import { IntegrationSlackConfig, type RcBotAssign, type RelayCpFrameType } from '@agentconnect.md/protocol'

const verifierOk = (over: Partial<Extract<SlackBotVerification, { status: 'ok' }>> = {}) =>
  vi.fn(
    async () =>
      ({
        status: 'ok',
        name: 'support-bot',
        appId: 'A0TESTAPP',
        botUserId: 'U0TESTBOT',
        teamId: 'T0TESTTEAM',
        teamName: 'Example Workspace',
        scopes: null,
        ...over
      }) as SlackBotVerification
  )

const ORG = OrgId('11111111-1111-4111-8111-111111111111')
const AGENT_ID = AgentId('77777777-7777-4777-8777-777777777777')

const INTEGRATION: IntegrationRecord = {
  id: IntegrationId('66666666-6666-4666-8666-666666666666'),
  orgId: ORG,
  agentId: AGENT_ID,
  botId: BotId('88888888-8888-4888-8888-888888888888'),
  platform: 'slack',
  name: 'support-bot',
  status: 'active',
  createdAt: new Date('2026-01-01T00:00:00Z')
}

function bot(over: Partial<BotRecord> = {}): BotRecord {
  return {
    id: BotId('88888888-8888-4888-8888-888888888888'),
    orgId: ORG,
    platform: 'slack',
    name: 'support-bot',
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
    discordAppId: null,
    feishuAppId: null,
    feishuRegion: null,
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

// Socket bots store xoxb + xapp; http bots store xoxb + the signing secret.
const SOCKET_SECRET: BotSecretMaterial = {
  botToken: 'xoxb-test-token',
  appToken: 'xapp-1-A0TESTAPP-123-abc',
  signingSecret: null
}
const HTTP_SECRET: BotSecretMaterial = { botToken: 'xoxb-test-token', appToken: null, signingSecret: 'shh-secret' }

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

// §9 adoption: the live spec/assign paths reach this provider THROUGH the
// registry, so the equivalence suites below drive the real registry rather than
// calling the provider beside the live path.
const PLATFORMS = buildCpPlatformRegistry([createSlackCpProvider({ verifyBot: verifierOk() })])

describe('slack provider identity + declarative facets', () => {
  const provider = createSlackCpProvider({ verifyBot: verifierOk() })

  it('declares the slack platform id', () => {
    expect(provider.platformId).toBe('slack')
  })

  it('hands out the injected funnel plugins per mount scope, empty when uncomposed', () => {
    // Focused composition (no funnel deps) ⇒ nothing at either scope.
    expect(provider.installRoutes('org')).toEqual([])
    expect(provider.installRoutes('public-callback')).toEqual([])
    // Composed: the org-scoped wizard/config plugins and the two public OAuth
    // callbacks come back exactly as injected (identity — same closures the
    // composition root builds from the live route factories).
    const org = [vi.fn(), vi.fn(), vi.fn()] as unknown as FastifyPluginAsync[]
    const publicCallback = [vi.fn(), vi.fn()] as unknown as FastifyPluginAsync[]
    const composed = createSlackCpProvider({ funnelRoutes: { org, publicCallback } })
    expect(composed.installRoutes('org')).toEqual(org)
    expect(composed.installRoutes('public-callback')).toEqual(publicCallback)
  })

  it('re-exports the same credential schema instance the create DTO composes', () => {
    expect(provider.credentialBodySchema).toBe(SlackCreateCredentials)
    expect(provider.credentialBodySchema.parse({ botToken: 'xoxb-1' })).toEqual({ botToken: 'xoxb-1' })
    expect(provider.credentialBodySchema.safeParse({ botToken: '' }).success).toBe(false)
    expect(provider.credentialBodySchema.safeParse({}).success).toBe(false)
  })

  it('packs the three-slot secret row and gates http assigns on the signing secret', () => {
    expect(Object.keys(provider.secretShape.slots)).toEqual(['botToken', 'appToken', 'signingSecret'])
    // The gate `HttpBotOrchestrator.syncBot` / `replayTo` apply before building
    // an assign for a slack bot.
    expect(provider.secretShape.httpAssignRequires).toEqual(['signingSecret'])
  })

  it('owns the install-reaper knobs + SLACK_PLATFORM_* env keys, spread into AppConfigSchema', () => {
    expect(provider.envSchema).toBe(SlackCpEnvSchema)
    expect(Object.keys(SlackCpEnvSchema)).toEqual([
      'SLACK_INSTALL_TTL_SEC',
      'SLACK_INSTALL_REAP_INTERVAL_SEC',
      'SLACK_PLATFORM_APP_ID',
      'SLACK_PLATFORM_CLIENT_ID',
      'SLACK_PLATFORM_CLIENT_SECRET',
      'SLACK_PLATFORM_SIGNING_SECRET'
    ])
    // One implementation: the live config schema is composed FROM this shape.
    for (const key of Object.keys(SlackCpEnvSchema)) {
      expect(AppConfigSchema.shape[key as keyof typeof AppConfigSchema.shape]).toBe(
        SlackCpEnvSchema[key as keyof typeof SlackCpEnvSchema]
      )
    }
  })

  it('declares the two pending-install funnels from the injected stores + env TTLs', () => {
    const installs = { reapExpired: vi.fn(async () => 0) }
    const platformInstalls = { reapExpired: vi.fn(async () => 0) }
    const composed = createSlackCpProvider({
      pendingInstalls: { installs, platformInstalls, ttlMs: 3_600_000, intervalMs: 600_000 }
    })
    expect(composed.pendingInstalls).toEqual([
      { model: 'SlackInstall', label: 'slack-install', store: installs, ttlMs: 3_600_000, intervalMs: 600_000 },
      {
        model: 'SlackPlatformInstall',
        label: 'slack-platform-install',
        store: platformInstalls,
        ttlMs: 3_600_000,
        intervalMs: 600_000
      }
    ])
    expect(provider.pendingInstalls).toBeUndefined() // uncomposed ⇒ undeclared
  })

  it('wraps the injected bot-identity reconciler as the one background loop', () => {
    const identityReconciler = { start: vi.fn(), stop: vi.fn() }
    const composed = createSlackCpProvider({ identityReconciler })
    expect(composed.backgroundLoops).toHaveLength(1)
    expect(composed.backgroundLoops![0]!.label).toBe('slack-bot-identity')
    composed.backgroundLoops![0]!.start()
    expect(identityReconciler.start).toHaveBeenCalledTimes(1)
    composed.backgroundLoops![0]!.stop()
    expect(identityReconciler.stop).toHaveBeenCalledTimes(1)
    expect(provider.backgroundLoops).toBeUndefined()
  })

  it('declares no install side effects (Slack renders per-message icon_url instead)', () => {
    expect(provider.sideEffects).toBeUndefined()
  })

  it('implements projectBotAssign — Slack has an HTTP/relay path (S3 erratum)', () => {
    expect(typeof provider.projectBotAssign).toBe('function')
  })
})

describe('slack refineCreateBody (DTO parity: the create body superRefine slack arm)', () => {
  const issues = (body: { credentials: SlackCreateCredentials; transport: 'socket' | 'http' }) => {
    const out: string[] = []
    refineSlackCreateBody(body, (message) => out.push(message))
    return out
  }

  it('requires the signing secret for http and the app token for socket', () => {
    expect(issues({ credentials: { botToken: 'xoxb-1' }, transport: 'http' })).toEqual([
      'http transport requires slack.signingSecret'
    ])
    expect(issues({ credentials: { botToken: 'xoxb-1' }, transport: 'socket' })).toEqual([
      'socket transport requires slack.appToken'
    ])
    expect(issues({ credentials: { botToken: 'xoxb-1', signingSecret: 's' }, transport: 'http' })).toEqual([])
    expect(issues({ credentials: { botToken: 'xoxb-1', appToken: 'xapp-1' }, transport: 'socket' })).toEqual([])
  })

  it('is the same rule the live create DTO enforces (one implementation)', () => {
    // The live body is COMPOSED from the registry (§9), so the rule reaches the
    // DTO through the provider's `refineCreateBody` — no second copy anywhere.
    const CreateIntegrationBody = buildCreateIntegrationBody(buildCpPlatformRegistry([createSlackCpProvider({})]))
    const base = { platform: 'slack', agentId: AGENT_ID as string }
    const http = CreateIntegrationBody.safeParse({ ...base, transport: 'http', slack: { botToken: 'xoxb-1' } })
    expect(http.success).toBe(false)
    expect(http.error?.issues.map((i) => i.message)).toContain('http transport requires slack.signingSecret')
    // An omitted transport is the create route's socket default.
    const socket = CreateIntegrationBody.safeParse({ ...base, slack: { botToken: 'xoxb-1' } })
    expect(socket.success).toBe(false)
    expect(socket.error?.issues.map((i) => i.message)).toContain('socket transport requires slack.appToken')
  })
})

describe('slack validateConfig (route parity: integrations.ts slack arm)', () => {
  const CREDS: SlackCreateCredentials = { botToken: 'xoxb-test', appToken: 'xapp-1-A0TESTAPP-123-abc' }

  it('derives the full identity from auth.test on the socket path', async () => {
    const verifyBot = verifierOk()
    const verifyAppToken = vi.fn(async () => 'ok' as const)
    const provider = createSlackCpProvider({ verifyBot, verifyAppToken })
    const result = await provider.validateConfig(CREDS, 'socket')
    expect(verifyBot).toHaveBeenCalledWith('xoxb-test')
    expect(verifyAppToken).toHaveBeenCalledWith('xapp-1-A0TESTAPP-123-abc')
    expect(result).toEqual({
      ok: true,
      identity: {
        name: 'support-bot',
        externalAppId: 'A0TESTAPP',
        botUserId: 'U0TESTBOT',
        workspaceId: 'T0TESTTEAM',
        workspaceName: 'Example Workspace'
      }
    })
  })

  it('refuses a rejected bot token with the route’s 400 copy', async () => {
    const provider = createSlackCpProvider({ verifyBot: vi.fn(async () => ({ status: 'invalid' as const })) })
    expect(await provider.validateConfig(CREDS, 'socket')).toEqual({
      ok: false,
      status: 400,
      message: 'Slack rejected the bot token — check you pasted the Bot User OAuth Token (xoxb-…).'
    })
  })

  it('refuses a rejected app-level token (socket only) with the route’s 400 copy', async () => {
    const provider = createSlackCpProvider({
      verifyBot: verifierOk(),
      verifyAppToken: vi.fn(async () => 'invalid' as const)
    })
    expect(await provider.validateConfig(CREDS, 'socket')).toEqual({
      ok: false,
      status: 400,
      message:
        'Slack rejected the app-level token — check you pasted the App-Level Token (xapp-…) and gave it the connections:write scope.'
    })
  })

  it('refuses a bot token and app-level token from different apps', async () => {
    const provider = createSlackCpProvider({
      verifyBot: verifierOk({ appId: 'A0OTHERAPP' }),
      verifyAppToken: vi.fn(async () => 'ok' as const)
    })
    expect(await provider.validateConfig(CREDS, 'socket')).toEqual({
      ok: false,
      status: 400,
      message: 'The Slack bot token and app-level token belong to different apps.'
    })
    // The same derivation the route runs (relocated helper).
    expect(slackAppIdFromAppToken(CREDS.appToken!)).toBe('A0TESTAPP')
  })

  it('never refuses on reachability: unreachable checks proceed with no derived identity', async () => {
    const provider = createSlackCpProvider({
      verifyBot: vi.fn(async () => ({ status: 'unreachable' as const })),
      verifyAppToken: vi.fn(async () => 'unreachable' as const)
    })
    expect(await provider.validateConfig(CREDS, 'socket')).toEqual({ ok: true, identity: {} })
  })

  it('skips validation entirely when no verifier is composed (route parity)', async () => {
    const provider = createSlackCpProvider({})
    expect(await provider.validateConfig(CREDS, 'socket')).toEqual({ ok: true, identity: {} })
  })

  it('runs no app-token check on the http path (relay availability stays core)', async () => {
    const verifyAppToken = vi.fn(async () => 'invalid' as const)
    const provider = createSlackCpProvider({ verifyBot: verifierOk(), verifyAppToken })
    const result = await provider.validateConfig({ botToken: 'xoxb-test', signingSecret: 'shh' }, 'http')
    expect(verifyAppToken).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
  })

  // The manual Bot-token wizard is the third install path the #768 scope fences
  // cover: a workspace authorization that positively granted fewer bot scopes
  // than the manifest declares must fail HERE, not weeks later as scoped calls
  // answering `missing_scope`.
  it('refuses a short workspace grant on BOTH transports, naming the missing scopes', async () => {
    const provider = createSlackCpProvider({
      verifyBot: verifierOk({ scopes: ['chat:write'] }),
      verifyAppToken: vi.fn(async () => 'ok' as const)
    })
    const missing = SLACK_BOT_SCOPES.filter((scope) => scope !== 'chat:write')
    const refusal = {
      ok: false,
      status: 400,
      code: 'SLACK_MISSING_SCOPES',
      message: `Slack didn’t grant every permission this app needs. Reinstall it in your Slack workspace, then connect again. Missing: ${missing.join(', ')}`
    }
    expect(await provider.validateConfig(CREDS, 'socket')).toEqual(refusal)
    expect(await provider.validateConfig({ botToken: 'xoxb-test', signingSecret: 'shh' }, 'http')).toEqual(refusal)
  })

  it('proceeds on a complete grant (extra scopes a workspace holds are not a reason to refuse)', async () => {
    const provider = createSlackCpProvider({
      verifyBot: verifierOk({ scopes: [...SLACK_BOT_SCOPES, 'bookmarks:read'] }),
      verifyAppToken: vi.fn(async () => 'ok' as const)
    })
    expect((await provider.validateConfig(CREDS, 'socket')).ok).toBe(true)
  })

  // Slack does not always send the `x-oauth-scopes` header. An unreported grant
  // is "we could not tell", NOT "the grant is short" — refusing on it would fail
  // installs for a reason unrelated to permissions (#768's tri-state rule).
  it('never refuses when Slack did not report the granted scopes (unknown ≠ short)', async () => {
    const provider = createSlackCpProvider({
      verifyBot: verifierOk({ scopes: null }),
      verifyAppToken: vi.fn(async () => 'ok' as const)
    })
    expect((await provider.validateConfig(CREDS, 'socket')).ok).toBe(true)
  })

  // The scope fence is checked LAST: a more specific credential refusal must
  // not be masked by a shortfall the wrong app's token happens to show.
  it('a mismatched token pair out-ranks the scope shortfall', async () => {
    const provider = createSlackCpProvider({
      verifyBot: verifierOk({ appId: 'A0OTHERAPP', scopes: ['chat:write'] }),
      verifyAppToken: vi.fn(async () => 'ok' as const)
    })
    expect(await provider.validateConfig(CREDS, 'socket')).toEqual({
      ok: false,
      status: 400,
      message: 'The Slack bot token and app-level token belong to different apps.'
    })
  })
})

describe('slack providerToolingCredentials (delegation to slack-user-config)', () => {
  const NOW = new Date('2026-01-02T00:00:00Z')
  const row = (over: Partial<SlackUserConfigRecord> = {}): SlackUserConfigRecord => ({
    orgId: ORG,
    userId: 'user-1',
    accessToken: 'xoxe.xoxp-access',
    refreshToken: null,
    accessExpiresAt: new Date(NOW.getTime() + 60 * 60 * 1000), // fresh for an hour
    updatedAt: NOW,
    ...over
  })
  const userConfigSeams = (stored: SlackUserConfigRecord | null) => ({
    configApi: {
      createApp: vi.fn(),
      exportApp: vi.fn(),
      updateApp: vi.fn(),
      exchangeOAuth: vi.fn(),
      rotateConfigToken: vi.fn(async () => ({ ok: false as const, error: 'invalid_refresh_token' }))
    } as unknown as NonNullable<SlackUserConfigDeps['slackConfigApi']>,
    store: {
      get: vi.fn(async () => stored),
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {})
    }
  })

  it('resolves a fresh stored access token (resolveUserConfigAccessToken body)', async () => {
    const provider = createSlackCpProvider({
      toolingCredentials: createSlackToolingCredentials(userConfigSeams(row()))
    })
    const tooling = provider.providerToolingCredentials!
    expect(tooling.model).toBe('SlackUserConfig')
    expect(await tooling.resolveAccessToken(ORG, 'user-1', NOW)).toEqual({
      ok: true,
      accessToken: 'xoxe.xoxp-access'
    })
    expect(await tooling.usableNow(ORG, 'user-1', NOW)).toBe(true)
  })

  it('reports not_configured / unusable when nothing is stored', async () => {
    const provider = createSlackCpProvider({ toolingCredentials: createSlackToolingCredentials(userConfigSeams(null)) })
    const tooling = provider.providerToolingCredentials!
    expect(await tooling.resolveAccessToken(ORG, 'user-1', NOW)).toEqual({ ok: false, reason: 'not_configured' })
    expect(await tooling.usableNow(ORG, 'user-1', NOW)).toBe(false)
  })

  it('a lapsed access-only token is expired for installs and unusable for the wizard', async () => {
    const lapsed = row({ accessExpiresAt: new Date(NOW.getTime() - 1000) })
    const provider = createSlackCpProvider({
      toolingCredentials: createSlackToolingCredentials(userConfigSeams(lapsed))
    })
    const tooling = provider.providerToolingCredentials!
    expect(await tooling.resolveAccessToken(ORG, 'user-1', NOW)).toEqual({ ok: false, reason: 'expired' })
    expect(await tooling.usableNow(ORG, 'user-1', NOW)).toBe(false)
  })

  it('is absent when no user-config seam is composed', () => {
    expect(createSlackCpProvider({}).providerToolingCredentials).toBeUndefined()
  })

  it('reports unreachable — never a store read — when no config API is composed', async () => {
    // Absent `configApi` is the funnel-off meaning `resolveUserConfigAccessToken`
    // has always had. It must be an explicit omission: this facet's argument
    // takes the client BY NAME precisely because a bundle that merely lacked the
    // (optional) member used to satisfy the old parameter type silently.
    const seams = userConfigSeams(row())
    const tooling = createSlackToolingCredentials({ store: seams.store })
    expect(await tooling.resolveAccessToken(ORG, 'user-1', NOW)).toEqual({ ok: false, reason: 'unreachable' })
    expect(seams.store.get).not.toHaveBeenCalled()
    // `usableNow` never needed the API — it reads the store directly, which is
    // why the production regression this shape prevents was invisible to it.
    expect(await tooling.usableNow(ORG, 'user-1', NOW)).toBe(true)
    expect(seams.store.get).toHaveBeenCalledOnce()
  })
})

describe('slack projection equivalence with the live integrationToSpec path (direct/socket)', () => {
  const SOCKET_BOT = bot()

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

  // GOLDEN: the literal payload the PRE-ADOPTION `integrationToSpec` slack arm
  // emitted for these inputs — frozen here so the flip to the provider projector
  // is provably byte-identical rather than merely self-consistent.
  it('emits the byte-identical direct payload the pre-adoption slack arm produced', async () => {
    const spec = await integrationToSpec(
      PLATFORMS,
      INTEGRATION,
      SOCKET_BOT,
      SOCKET_SECRET,
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
      platform: 'slack',
      core: { mode: 'direct', bindRules, mutedChannels: ['C3'], gated: false },
      // §6.4 final shape: platform-private material ONLY — the routing knobs
      // and the ingress mode ride the core envelope, never the config payload.
      config: {
        shareable: false, // a socket bot is single-agent by construction
        botToken: 'xoxb-test-token',
        appToken: 'xapp-1-A0TESTAPP-123-abc' // Socket Mode carries the app-level token
      }
    })
  })

  // Across the channel/gating permutations the pin is the EXTRACTED helper — the
  // unchanged body the pre-adoption arm called — which catches core threading the
  // wrong envelope, the wrong secret, or the wrong direct/shared arm into the seam.
  for (const { label, channels, gated } of cases) {
    it(`routes the live path through the slack projector unchanged — ${label}`, async () => {
      const spec = await integrationToSpec(PLATFORMS, INTEGRATION, SOCKET_BOT, SOCKET_SECRET, channels, gated)
      if (!spec) throw new Error('expected a deliverable spec')
      expect(spec.core.mode).toBe('direct')
      expect(spec.config).toEqual(slackIntegrationConfig(SOCKET_SECRET))
      // The payload satisfies the daemon reader's wire schema (§6.4).
      expect(() => IntegrationSlackConfig.parse(spec.config)).not.toThrow()
    })
  }
})

describe('slack projection equivalence with the live httpIntegrationToSpec path (shared/http)', () => {
  const cases: Array<{
    label: string
    bot: BotRecord
    channels: IntegrationChannelRecord[]
    gated: boolean
  }> = [
    {
      label: 'shareable bot with a provider app id',
      bot: bot({ transport: 'http', shareable: true, slackAppId: 'A0TESTAPP' }),
      channels: [channel('C1', 'any'), channel('C2', 'off')],
      gated: false
    },
    {
      label: 'non-shareable manual-paste bot (no app id)',
      bot: bot({ transport: 'http', shareable: false }),
      channels: [],
      gated: false
    },
    {
      label: 'gated member (conversation-scoped rules ride the send-only spec)',
      bot: bot({ transport: 'http', shareable: true, slackAppId: 'A0TESTAPP' }),
      channels: [channel('C1', 'mention'), channel('D1', 'any', 'im'), channel('C2', 'off')],
      gated: true
    }
  ]

  // GOLDEN: the literal payload the PRE-ADOPTION `httpIntegrationToSpec` slack
  // arm emitted. Send-only by credential domaining — xoxb but NEVER the appToken.
  it('emits the byte-identical shared payload the pre-adoption slack arm produced', async () => {
    const httpBot = bot({ transport: 'http', shareable: true, slackAppId: 'A0TESTAPP' })
    const spec = await httpIntegrationToSpec(
      PLATFORMS,
      INTEGRATION,
      httpBot,
      HTTP_SECRET,
      [channel('C1', 'any'), channel('C2', 'off')],
      false
    )
    expect(spec).toEqual({
      orgId: INTEGRATION.orgId,
      integrationId: INTEGRATION.id,
      agentId: INTEGRATION.agentId,
      platform: 'slack',
      // Ungated shared installs ship NO bindRules — the relay arbitrates.
      core: { mode: 'shared', bindRules: [], mutedChannels: ['C2'], gated: false },
      config: {
        shareable: true,
        botToken: 'xoxb-test-token',
        appId: 'A0TESTAPP'
      }
    })
    expect(spec?.config).not.toHaveProperty('appToken')
  })

  for (const { label, bot: httpBot, channels, gated } of cases) {
    it(`routes the live path through the slack projector unchanged — ${label}`, async () => {
      // The bot row is passed WHOLE now: `shareable` / the provider app id /
      // `botUserId` are read off it by the projector instead of being forwarded
      // positionally by each call site.
      const spec = await httpIntegrationToSpec(PLATFORMS, INTEGRATION, httpBot, HTTP_SECRET, channels, gated)
      if (!spec) throw new Error('expected a deliverable spec')
      expect(spec.core.mode).toBe('shared')
      expect(spec.config).toEqual(
        slackSharedIntegrationConfig(HTTP_SECRET, httpBot.shareable, httpBot.slackAppId ?? undefined)
      )
      expect(() => IntegrationSlackConfig.parse(spec.config)).not.toThrow()
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
  const integration: IntegrationRecord = { ...INTEGRATION, platform: botRow.platform, botId: botRow.id }
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

describe('slack projectBotAssign equivalence with the live buildAssign frame (§6.7)', () => {
  const provider = createSlackCpProvider({ verifyBot: verifierOk() })

  it('manual-paste http bot (no xapp to parse): bare secrets bag, empty ingress bag', async () => {
    const manualPaste = bot({ transport: 'http', shareable: true })
    const frame = await liveAssignFrame(manualPaste, HTTP_SECRET)
    const projected = await provider.projectBotAssign!(manualPaste, HTTP_SECRET)
    expect(projected.secrets).toEqual(frame.secrets)
    expect(projected.ingress).toEqual(frame.ingress)
    expect(projected).toEqual({
      secrets: { botToken: 'xoxb-test-token', signingSecret: 'shh-secret' },
      ingress: {} // no app id persisted — the relay verify-scans instead
    })
  })

  it('tenant-scoped platform-app install: composite (apiAppId, teamId) + botUserId demux', async () => {
    const platformInstall = bot({
      transport: 'http',
      prebuilt: true,
      slackAppId: 'A0PLATFORM',
      teamId: 'T0TESTTEAM',
      botUserId: 'U0BOT'
    })
    const frame = await liveAssignFrame(platformInstall, HTTP_SECRET)
    const projected = await provider.projectBotAssign!(platformInstall, HTTP_SECRET)
    expect(projected.secrets).toEqual(frame.secrets)
    expect(projected.ingress).toEqual(frame.ingress)
    expect(projected.ingress).toEqual({ apiAppId: 'A0PLATFORM', teamId: 'T0TESTTEAM', botUserId: 'U0BOT' })
  })

  it('shares one implementation with httpBot.ts (the extracted helper)', async () => {
    const quickInstall = bot({ transport: 'http', slackAppId: 'A0TESTAPP' })
    const frame = await liveAssignFrame(quickInstall, HTTP_SECRET)
    expect(slackBotAssignBags(quickInstall, HTTP_SECRET)).toEqual({
      secrets: frame.secrets,
      ingress: frame.ingress
    })
  })

  it('projects the workspace tenant fence for a NON-distributed bot (ingress-tenant-fence.md §3)', async () => {
    // The case the fence exists for: no teamId (quick-install), but the
    // workspace identity captured at install/backfill must reach the relay —
    // without it, a same-secret sibling in another org verifies this bot's
    // deliveries and nothing discriminates.
    const quickInstall = bot({ transport: 'http', slackAppId: 'A0TESTAPP', workspaceId: 'T0WORKSPACE' })
    const frame = await liveAssignFrame(quickInstall, HTTP_SECRET)
    const projected = await provider.projectBotAssign!(quickInstall, HTTP_SECRET)
    expect(projected.ingress).toEqual(frame.ingress)
    expect(projected.ingress).toEqual({ apiAppId: 'A0TESTAPP', workspaceId: 'T0WORKSPACE' })
  })
})
