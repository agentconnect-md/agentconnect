/**
 * Platform-published (distributed) Slack app install (preset-agents.md §5.3) —
 * start route (state minting, preset default target, relay precondition),
 * the unauthenticated OAuth callback (create / re-install / cross-org refusal),
 * and the revocation path from `rc/bot-revoked`.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { seedAgent } from '../fixtures/seed.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { provisionPresetAgents } from '../../src/persistence/index.js'
import type { RelayChannel } from '../../src/ws/relay-registry.js'
import type {
  SlackConfigApi,
  SlackAppCreateResult,
  SlackManifestExportResult,
  SlackManifestUpdateResult,
  SlackOAuthExchangeResult,
  SlackRotateResult
} from '../../src/http/slack-config-api.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const PLATFORM = {
  appId: 'A0PLATFORM',
  clientId: 'platform-client-id',
  clientSecret: 'platform-client-secret',
  signingSecret: 'platform-signing-secret'
}

/** Exchange-only stub — the platform path never creates apps or rotates tokens. */
class StubExchangeApi implements SlackConfigApi {
  exchangeResult: SlackOAuthExchangeResult = {
    ok: true,
    result: {
      botToken: 'xoxb-workspace-token',
      appId: PLATFORM.appId,
      teamId: 'T0WORKSPACE',
      teamName: 'Acme',
      botUserId: 'U0BOT'
    }
  }
  exchangeCalls: Array<{ clientId: string; clientSecret: string; code: string; redirectUri: string }> = []
  async createApp(): Promise<SlackAppCreateResult> {
    return { ok: false, error: 'unused' }
  }
  async exportApp(): Promise<SlackManifestExportResult> {
    return { ok: false, error: 'unused' }
  }
  async updateApp(): Promise<SlackManifestUpdateResult> {
    return { ok: false, error: 'unused' }
  }
  async exchangeOAuth(p: {
    clientId: string
    clientSecret: string
    code: string
    redirectUri: string
  }): Promise<SlackOAuthExchangeResult> {
    this.exchangeCalls.push(p)
    return this.exchangeResult
  }
  async rotateConfigToken(): Promise<SlackRotateResult> {
    return { ok: false, error: 'unused' }
  }
}

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

function withPlatform(opts?: { configured?: boolean; relay?: boolean }): { app: HttpApp; stub: StubExchangeApi } {
  const stub = new StubExchangeApi()
  const app = buildHttpApp(
    prisma,
    {
      PUBLIC_CP_URL: 'https://cp.example',
      ...(opts?.relay !== false ? { PUBLIC_RELAY_URL: 'wss://relay.example' } : {}),
      PUBLIC_WEB_URL: 'https://console.example'
    },
    undefined,
    undefined,
    {
      slackConfigApi: stub,
      ...(opts?.configured !== false ? { slackPlatformApp: PLATFORM } : {})
    }
  )
  if (opts?.relay !== false) {
    app.relayReg.add({ relayId: 'r1', send: () => {}, close: () => {} } as RelayChannel)
  }
  running = app
  return { app, stub }
}

async function startInstall(app: HttpApp, agentId?: string): Promise<{ id: string; installUrl: string }> {
  const res = await app.app.inject({
    method: 'POST',
    url: `${ORG}/integrations/slack/platform-install`,
    payload: agentId ? { agentId } : {}
  })
  expect(res.statusCode).toBe(201)
  return res.json() as { id: string; installUrl: string }
}

describe('POST /integrations/slack/platform-install', () => {
  it('404s when the platform app is not configured (self-hosted default)', async () => {
    const { app } = withPlatform({ configured: false })
    const res = await app.app.inject({ method: 'POST', url: `${ORG}/integrations/slack/platform-install`, payload: {} })
    expect(res.statusCode).toBe(404)
  })

  it('409s without a connected relay (Events-API-only path)', async () => {
    const { app } = withPlatform({ relay: false })
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/slack/platform-install`,
      payload: { agentId }
    })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { message: string }).message).toMatch(/relay/)
  })

  it('defaults the bind target to the org’s agentconnect preset — placement not required', async () => {
    const { app } = withPlatform()
    await provisionPresetAgents(prisma, { orgId: DEFAULT_ORG_ID })
    const preset = await prisma.agent.findUnique({
      where: { orgId_name: { orgId: DEFAULT_ORG_ID, name: 'agentconnect' } }
    })

    const started = await startInstall(app)
    const url = new URL(started.installUrl)
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize')
    expect(url.searchParams.get('client_id')).toBe(PLATFORM.clientId)
    expect(url.searchParams.get('state')).toBe(started.id)
    expect(url.searchParams.get('redirect_uri')).toBe('https://cp.example/v1/integrations/slack/platform/callback')
    expect(url.searchParams.get('scope')).toContain('chat:write')

    const row = await prisma.slackPlatformInstall.findUnique({ where: { id: started.id } })
    expect(row).toMatchObject({ orgId: DEFAULT_ORG_ID, agentId: preset!.id, createdByUserId: DEFAULT_OWNER_ID })
  })

  it('409s when neither an agentId nor a preset exists', async () => {
    const { app } = withPlatform()
    const res = await app.app.inject({ method: 'POST', url: `${ORG}/integrations/slack/platform-install`, payload: {} })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { message: string }).message).toMatch(/no target agent/)
  })
})

describe('GET /integrations/slack/platform/callback', () => {
  it('finishes the install: Bot with (appId, teamId) identity + Integration + relay assign', async () => {
    const { app, stub } = withPlatform()
    await provisionPresetAgents(prisma, { orgId: DEFAULT_ORG_ID })
    const started = await startInstall(app)

    const cb = await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=the-code&state=${started.id}`
    })
    expect(cb.statusCode).toBe(200)
    expect(cb.body).toContain('Connected to Slack')
    expect(stub.exchangeCalls[0]).toMatchObject({
      clientId: PLATFORM.clientId,
      clientSecret: PLATFORM.clientSecret,
      code: 'the-code',
      redirectUri: 'https://cp.example/v1/integrations/slack/platform/callback'
    })

    const bot = await prisma.bot.findUnique({
      where: { slackAppId_teamId: { slackAppId: PLATFORM.appId, teamId: 'T0WORKSPACE' } },
      include: { secret: true, integrations: true }
    })
    expect(bot).toMatchObject({
      orgId: DEFAULT_ORG_ID,
      transport: 'http',
      shareable: true,
      prebuilt: true,
      botUserId: 'U0BOT',
      name: 'AgentConnect (Acme)',
      revokedAt: null
    })
    expect(bot!.secret).toMatchObject({ botToken: 'xoxb-workspace-token', signingSecret: PLATFORM.signingSecret })
    const preset = await prisma.agent.findUnique({
      where: { orgId_name: { orgId: DEFAULT_ORG_ID, name: 'agentconnect' } }
    })
    expect(bot!.integrations).toHaveLength(1)
    expect(bot!.integrations[0]).toMatchObject({ agentId: preset!.id, status: 'active' })

    // The state row is consumed — a replayed callback reads as expired.
    expect(await prisma.slackPlatformInstall.findUnique({ where: { id: started.id } })).toBeNull()
    const replay = await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=again&state=${started.id}`
    })
    expect(replay.body).toContain('expired')
  })

  it('serves the public /v1 alias too (direct-hit deploys)', async () => {
    const { app } = withPlatform()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)
    const started = await startInstall(app, agentId)
    const cb = await app.app.inject({
      method: 'GET',
      url: `/v1/integrations/slack/platform/callback?code=c&state=${started.id}`
    })
    expect(cb.statusCode).toBe(200)
    expect(cb.body).toContain('Connected to Slack')
  })

  it('refuses a workspace already bound to a DIFFERENT org (workspace_taken)', async () => {
    const { app } = withPlatform()
    const otherOrg = await prisma.org.create({ data: { slug: `other-${randomUUID().slice(0, 8)}` } })
    await prisma.bot.create({
      data: {
        id: randomUUID(),
        orgId: otherOrg.id,
        platform: 'slack',
        name: 'AgentConnect (Theirs)',
        transport: 'http',
        shareable: true,
        prebuilt: true,
        slackAppId: PLATFORM.appId,
        teamId: 'T0WORKSPACE'
      }
    })
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)
    const started = await startInstall(app, agentId)

    const cb = await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=c&state=${started.id}`
    })
    expect(cb.statusCode).toBe(200)
    expect(cb.body).toContain('already connected to a different AgentConnect organization')
    // No second bot minted, no integration for our agent.
    expect(await prisma.bot.count({ where: { slackAppId: PLATFORM.appId } })).toBe(1)
    expect(await prisma.integration.count({ where: { agentId } })).toBe(0)
  })

  it('re-install into the same org revives the bot: fresh token, cleared revocation', async () => {
    const { app } = withPlatform()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)

    // First install, then simulate a workspace uninstall (rc/bot-revoked path).
    const first = await startInstall(app, agentId)
    await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=c1&state=${first.id}`
    })
    const bot = await prisma.bot.findUniqueOrThrow({
      where: { slackAppId_teamId: { slackAppId: PLATFORM.appId, teamId: 'T0WORKSPACE' } }
    })
    await app.deps.sharedBot.revokeBot(bot.id, 'app_uninstalled')
    const revoked = await prisma.bot.findUniqueOrThrow({ where: { id: bot.id } })
    expect(revoked.revokedAt).toBeInstanceOf(Date)
    expect(await prisma.integration.count({ where: { botId: bot.id, status: 'revoked' } })).toBe(1)

    // Re-install: same Bot row revived, token rotated, a fresh active install.
    const second = await startInstall(app, agentId)
    const cb = await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=c2&state=${second.id}`
    })
    expect(cb.body).toContain('Connected to Slack')
    expect(await prisma.bot.count({ where: { slackAppId: PLATFORM.appId } })).toBe(1)
    const revived = await prisma.bot.findUniqueOrThrow({ where: { id: bot.id }, include: { secret: true } })
    expect(revived.revokedAt).toBeNull()
    expect(revived.secret?.botToken).toBe('xoxb-workspace-token')
    expect(await prisma.integration.count({ where: { botId: bot.id, status: 'active', agentId } })).toBe(1)
  })

  it('rejects an exchange for the wrong app or a missing team id', async () => {
    const { app, stub } = withPlatform()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)
    const started = await startInstall(app, agentId)
    stub.exchangeResult = {
      ok: true,
      result: { botToken: 'x', appId: 'AOTHER', teamId: 'T0', teamName: null, botUserId: null }
    }

    const cb = await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=c&state=${started.id}`
    })
    expect(cb.body).toContain('Something went wrong')
    expect(await prisma.bot.count()).toBe(0)
  })

  it('user denial and unknown state render the throwaway pages, minting nothing', async () => {
    const { app } = withPlatform()
    const denied = await app.app.inject({
      method: 'GET',
      url: '/api/v1/integrations/slack/platform/callback?error=access_denied'
    })
    expect(denied.body).toContain('cancelled')

    const unknown = await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=c&state=${randomUUID()}`
    })
    expect(unknown.body).toContain('expired')
    expect(await prisma.bot.count()).toBe(0)
  })
})

describe('GET /slack/config platform flag', () => {
  it('reports platformInstallAvailable when creds + callback + relay all hold', async () => {
    const { app } = withPlatform()
    const on = await app.app.inject({ method: 'GET', url: `${ORG}/slack/config` })
    expect((on.json() as { platformInstallAvailable: boolean }).platformInstallAvailable).toBe(true)
  })

  it('stays false when the platform creds are absent', async () => {
    const { app } = withPlatform({ configured: false })
    const off = await app.app.inject({ method: 'GET', url: `${ORG}/slack/config` })
    expect((off.json() as { platformInstallAvailable: boolean }).platformInstallAvailable).toBe(false)
  })
})
