/**
 * Platform-published (distributed) Slack app install (preset-agents.md §5.3) —
 * start route (state minting, preset default target, relay precondition),
 * the unauthenticated OAuth callback (create / re-install / cross-org refusal),
 * and the revocation path from `rc/bot-revoked`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { provisionPresetAgents } from '../../src/persistence/index.js'
import { SLACK_BOT_SCOPES } from '../../src/http/slack-manifest.js'
import type { RelayChannel } from '../../src/ws/relay-registry.js'
import type {
  SlackConfigApi,
  SlackAppCreateResult,
  SlackManifestExportResult,
  SlackManifestUpdateResult,
  SlackOAuthExchangeResult,
  SlackRotateResult
} from '../../src/http/slack-config-api.js'

/** Wait until a backend is genuinely queued on a row lock — the interleaving each race below is
 *  written for. Sleeping a fixed guess instead runs a DIFFERENT interleaving whenever the runner
 *  is slower than the guess, silently, and the race the test names then goes uncovered. */
async function awaitLockWaiter(): Promise<void> {
  await vi.waitFor(
    async () => {
      const rows = await prisma.$queryRaw<Array<{ waiting: bigint }>>`
        SELECT count(*)::bigint AS "waiting"
        FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
      `
      expect(Number(rows[0]?.waiting ?? 0n)).toBeGreaterThanOrEqual(1)
    },
    { timeout: 20_000, interval: 10 }
  )
}

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

async function startReauthorization(app: HttpApp, botId: string): Promise<{ id: string; installUrl: string }> {
  const res = await app.app.inject({
    method: 'POST',
    url: `${ORG}/integrations/slack/platform-install`,
    payload: { botId }
  })
  expect(res.statusCode).toBe(201)
  return res.json() as { id: string; installUrl: string }
}

/** Poll one install's terminal state — the console's completion signal. */
async function status(app: HttpApp, id: string) {
  return app.app.inject({ method: 'GET', url: `${ORG}/integrations/slack/platform-install/${id}` })
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
    // Slack grants exactly the scopes this parameter names, so it must carry the FULL
    // manifest set: a capability scope declared but never requested is one no install
    // holds, and its tool answers `missing_scope` forever.
    expect(url.searchParams.get('scope')?.split(',')).toEqual([...SLACK_BOT_SCOPES])

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
      where: {
        platform_externalAppId_externalTenantId: {
          platform: 'slack',
          externalAppId: PLATFORM.appId,
          externalTenantId: 'T0WORKSPACE'
        }
      },
      include: { secret: true, integrations: true }
    })
    expect(bot).toMatchObject({
      orgId: DEFAULT_ORG_ID,
      // Always http (a distributed app has no per-workspace xapp) and always
      // NON-shareable (one workspace install ⇒ exactly one agent, §5.5).
      transport: 'http',
      shareable: false,
      prebuilt: true,
      botUserId: 'U0BOT',
      name: 'AgentConnect (Acme)',
      workspaceId: 'T0WORKSPACE',
      workspaceName: 'Acme',
      revokedAt: null
    })
    expect(bot!.secret).toMatchObject({ botToken: 'xoxb-workspace-token', signingSecret: PLATFORM.signingSecret })
    const preset = await prisma.agent.findUnique({
      where: { orgId_name: { orgId: DEFAULT_ORG_ID, name: 'agentconnect' } }
    })
    expect(bot!.integrations).toHaveLength(1)
    expect(bot!.integrations[0]).toMatchObject({ agentId: preset!.id, status: 'active' })

    app.platformStubs.verifySlackBot = async () => ({
      status: 'ok',
      name: 'agentconnect',
      appId: PLATFORM.appId,
      teamId: 'T0WORKSPACE',
      teamName: 'Acme',
      scopes: [...SLACK_BOT_SCOPES]
    })
    const refreshed = await app.app.inject({
      method: 'POST',
      url: `${ORG}/bots/${bot!.id}/slack/refresh`
    })
    expect(refreshed.statusCode).toBe(200)
    expect(refreshed.json()).toMatchObject({
      manifest: 'synced',
      authorization: 'current',
      missingScopes: []
    })

    // The row SURVIVES as the console's completion signal, but the state is still
    // single-use: a replayed callback is refused rather than re-running the install.
    const settled = await prisma.slackPlatformInstall.findUnique({ where: { id: started.id } })
    expect(settled).toMatchObject({ status: 'completed', botId: bot!.id })
    const replay = await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=again&state=${started.id}`
    })
    expect(replay.body).toContain('expired')
    expect(await prisma.bot.count({ where: { slackAppId: PLATFORM.appId } })).toBe(1)
    // …and the replay did not advance the credential generation.
    expect((await prisma.bot.findUniqueOrThrow({ where: { id: bot!.id } })).credentialRevision).toBe(1)
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

  // The quick-install funnel's short-grant fence, on the distributed app. Slack
  // does not reliably apply every scope the authorize URL asked for, and the
  // shortfall is invisible until a scoped call starts answering `missing_scope`.
  it('refuses a workspace that granted fewer bot scopes, writing no bot (missing_scopes)', async () => {
    const { app } = withPlatform()
    const withheld = ['channels:history', 'users:read']
    app.platformStubs.verifySlackBot = async () => ({
      status: 'ok',
      name: 'agentconnect',
      appId: PLATFORM.appId,
      teamId: 'T0WORKSPACE',
      teamName: 'Acme',
      botUserId: 'U0BOT',
      scopes: SLACK_BOT_SCOPES.filter((scope) => !withheld.includes(scope))
    })
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)
    const started = await startInstall(app, agentId)

    const cb = await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=c&state=${started.id}`
    })
    expect(cb.statusCode).toBe(200)
    expect(cb.body).toContain('didn’t grant every permission')
    // Nothing was written: this is the last fence before the first mutation.
    expect(await prisma.bot.count({ where: { slackAppId: PLATFORM.appId } })).toBe(0)
    expect(await prisma.integration.count({ where: { agentId } })).toBe(0)
    // The console's only channel here is the poll (the OAuth tab is a
    // throwaway), so the row carries the scopes, not just the reason code.
    const polled = (await status(app, started.id)).json() as {
      status: string
      failureReason: string
      missingScopes: string[]
    }
    expect(polled).toMatchObject({ status: 'failed', failureReason: 'missing_scopes', missingScopes: withheld })
  })

  it('does not refuse when Slack did not report the granted scopes', async () => {
    const { app } = withPlatform()
    // The default stub is absent ⇒ the seam answers `unreachable`; make the
    // inconclusive case explicit — Slack answered, but sent no scope header.
    app.platformStubs.verifySlackBot = async () => ({
      status: 'ok',
      name: 'agentconnect',
      appId: PLATFORM.appId,
      teamId: 'T0WORKSPACE',
      teamName: 'Acme',
      botUserId: 'U0BOT',
      scopes: null
    })
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)
    const started = await startInstall(app, agentId)

    const cb = await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=c&state=${started.id}`
    })
    expect(cb.body).toContain('Connected to Slack')
    expect(await prisma.bot.count({ where: { slackAppId: PLATFORM.appId } })).toBe(1)
  })

  // A short grant must not out-rank the more specific refusals: it is checked
  // last, so "you authorized someone else's workspace" still wins.
  it('reports a cross-org workspace claim rather than the scope shortfall', async () => {
    const { app } = withPlatform()
    app.platformStubs.verifySlackBot = async () => ({
      status: 'ok',
      name: 'agentconnect',
      appId: PLATFORM.appId,
      teamId: 'T0WORKSPACE',
      teamName: 'Acme',
      botUserId: 'U0BOT',
      scopes: []
    })
    const otherOrg = await prisma.org.create({ data: { slug: `other-${randomUUID().slice(0, 8)}` } })
    await prisma.bot.create({
      data: {
        id: randomUUID(),
        orgId: otherOrg.id,
        platform: 'slack',
        name: 'AgentConnect (Theirs)',
        transport: 'http',
        shareable: false,
        prebuilt: true,
        slackAppId: PLATFORM.appId,
        teamId: 'T0WORKSPACE',
        workspaceId: 'T0WORKSPACE',
        externalAppId: PLATFORM.appId,
        externalTenantId: 'T0WORKSPACE'
      }
    })
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)
    const started = await startInstall(app, agentId)

    const cb = await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=c&state=${started.id}`
    })
    expect(cb.body).toContain('already connected to a different AgentConnect organization')
    expect((await status(app, started.id)).json()).toMatchObject({ failureReason: 'workspace_taken' })
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
        shareable: false,
        prebuilt: true,
        slackAppId: PLATFORM.appId,
        teamId: 'T0WORKSPACE',
        // What a real platform-app install writes: the callback sets workspaceId
        // from team.id, and PgBotRepo.create projects the demux identity. A row
        // carrying only the per-platform pair is a shape production cannot
        // produce, and fencing against it would prove nothing.
        workspaceId: 'T0WORKSPACE',
        externalAppId: PLATFORM.appId,
        externalTenantId: 'T0WORKSPACE'
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
      where: {
        platform_externalAppId_externalTenantId: {
          platform: 'slack',
          externalAppId: PLATFORM.appId,
          externalTenantId: 'T0WORKSPACE'
        }
      }
    })
    await app.deps.httpBot.revokeBot(bot.id, 'app_uninstalled')
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

  it('a Settings reauthorization refuses a different workspace before mutating the bot', async () => {
    const { app, stub } = withPlatform()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)
    const first = await startInstall(app, agentId)
    await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=c1&state=${first.id}`
    })
    const before = await prisma.bot.findFirstOrThrow({
      where: { slackAppId: PLATFORM.appId },
      include: { secret: true }
    })

    const reauthorization = await startReauthorization(app, before.id)
    expect(await prisma.slackPlatformInstall.findUniqueOrThrow({ where: { id: reauthorization.id } })).toMatchObject({
      agentId: null,
      botId: before.id
    })
    stub.exchangeResult = {
      ok: true,
      result: {
        botToken: 'xoxb-wrong-workspace',
        appId: PLATFORM.appId,
        teamId: 'T0OTHER',
        teamName: 'Other',
        botUserId: 'U0OTHER'
      }
    }

    const cb = await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=c2&state=${reauthorization.id}`
    })

    expect(cb.body).toContain('authorized a different workspace')
    expect((await status(app, reauthorization.id)).json()).toMatchObject({
      status: 'failed',
      failureReason: 'workspace_mismatch',
      botId: before.id
    })
    const after = await prisma.bot.findUniqueOrThrow({ where: { id: before.id }, include: { secret: true } })
    expect(after.credentialRevision).toBe(before.credentialRevision)
    expect(after.secret?.botToken).toBe(before.secret?.botToken)
    expect(await prisma.bot.count({ where: { slackAppId: PLATFORM.appId } })).toBe(1)
    expect(await prisma.integration.count({ where: { botId: before.id, status: 'active' } })).toBe(1)
  })

  it('reauthorizing a free Settings bot rotates its token without attaching an agent', async () => {
    const { app, stub } = withPlatform()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)
    const first = await startInstall(app, agentId)
    await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=c1&state=${first.id}`
    })
    const before = await prisma.bot.findFirstOrThrow({ where: { slackAppId: PLATFORM.appId } })
    await prisma.integration.deleteMany({ where: { botId: before.id } })
    await app.deps.httpBot.revokeBot(before.id, 'app_uninstalled')

    stub.exchangeResult = {
      ok: true,
      result: {
        botToken: 'xoxb-refreshed',
        appId: PLATFORM.appId,
        teamId: 'T0WORKSPACE',
        teamName: 'Acme',
        botUserId: 'U0BOT'
      }
    }
    const reauthorization = await startReauthorization(app, before.id)
    const cb = await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=c2&state=${reauthorization.id}`
    })

    expect(cb.body).toContain('Connected to Slack')
    expect((await status(app, reauthorization.id)).json()).toMatchObject({
      status: 'completed',
      botId: before.id
    })
    const after = await prisma.bot.findUniqueOrThrow({ where: { id: before.id }, include: { secret: true } })
    expect(after.credentialRevision).toBe(before.credentialRevision + 1)
    expect(after.secret?.botToken).toBe('xoxb-refreshed')
    expect(after.revokedAt).toBeNull()
    expect(await prisma.integration.count({ where: { botId: before.id } })).toBe(0)
  })

  it('a Settings reauthorization restores memberships revoked with the old credential', async () => {
    const { app, stub } = withPlatform()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)
    const first = await startInstall(app, agentId)
    await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=c1&state=${first.id}`
    })
    const before = await prisma.bot.findFirstOrThrow({ where: { slackAppId: PLATFORM.appId } })
    const integration = await prisma.integration.findFirstOrThrow({ where: { botId: before.id } })
    await app.deps.httpBot.revokeBot(before.id, 'app_uninstalled')
    expect(await prisma.integration.findUniqueOrThrow({ where: { id: integration.id } })).toMatchObject({
      status: 'revoked',
      revokedCredentialRevision: before.credentialRevision
    })

    stub.exchangeResult = {
      ok: true,
      result: {
        botToken: 'xoxb-restored',
        appId: PLATFORM.appId,
        teamId: 'T0WORKSPACE',
        teamName: 'Acme',
        botUserId: 'U0BOT'
      }
    }
    const reauthorization = await startReauthorization(app, before.id)
    const cb = await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=c2&state=${reauthorization.id}`
    })

    expect(cb.body).toContain('Connected to Slack')
    const after = await prisma.bot.findUniqueOrThrow({ where: { id: before.id }, include: { secret: true } })
    expect(after).toMatchObject({
      credentialRevision: before.credentialRevision + 1,
      revokedAt: null
    })
    expect(after.secret?.botToken).toBe('xoxb-restored')
    expect(await prisma.integration.findUniqueOrThrow({ where: { id: integration.id } })).toMatchObject({
      agentId,
      status: 'active',
      revokedCredentialRevision: null
    })
    expect(await prisma.integration.count({ where: { botId: before.id, status: 'active' } })).toBe(1)
  })

  // Slack does not order `app_uninstalled` / `tokens_revoked`: an event from the
  // install a re-install just replaced can still be in flight. Applying it would
  // revoke a live, freshly-authorized bot and silently kill its integrations.
  it('a delayed revoke from the PRIOR install leaves the re-installed bot active', async () => {
    const { app } = withPlatform()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)

    const first = await startInstall(app, agentId)
    await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=c1&state=${first.id}`
    })
    const bot = await prisma.bot.findUniqueOrThrow({
      where: {
        platform_externalAppId_externalTenantId: {
          platform: 'slack',
          externalAppId: PLATFORM.appId,
          externalTenantId: 'T0WORKSPACE'
        }
      }
    })
    expect(bot.credentialRevision).toBe(1)
    // The workspace uninstalls — the event is generated NOW but not delivered yet.
    const uninstalledAt = Date.now()

    // …the user re-installs first. The generation advances with the new credential.
    const second = await startInstall(app, agentId)
    await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=c2&state=${second.id}`
    })
    const reinstalled = await prisma.bot.findUniqueOrThrow({ where: { id: bot.id } })
    expect(reinstalled.credentialRevision).toBe(2)
    expect(reinstalled.credentialInstalledAt).toBeInstanceOf(Date)

    // NOW the stale event lands. A relay that missed the re-assign echoes revision 1;
    // one that already applied it echoes revision 2 with the OLD occurrence time.
    // Both must be refused.
    await app.deps.httpBot.revokeBot(bot.id, 'app_uninstalled', { revision: 1, eventAtMs: uninstalledAt })
    await app.deps.httpBot.revokeBot(bot.id, 'app_uninstalled', { revision: 2, eventAtMs: uninstalledAt })

    const after = await prisma.bot.findUniqueOrThrow({ where: { id: bot.id } })
    expect(after.revokedAt).toBeNull()
    expect(await prisma.integration.count({ where: { botId: bot.id, status: 'active' } })).toBe(1)

    // A genuine LATER uninstall of the current generation still works.
    await app.deps.httpBot.revokeBot(bot.id, 'app_uninstalled', {
      revision: 2,
      eventAtMs: after.credentialInstalledAt!.getTime() + 1000
    })
    const finallyRevoked = await prisma.bot.findUniqueOrThrow({ where: { id: bot.id } })
    expect(finallyRevoked.revokedAt).toBeInstanceOf(Date)
    expect(await prisma.integration.count({ where: { botId: bot.id, status: 'revoked' } })).toBe(1)
  })

  // The secret and the generation it belongs to must land together: a reader that
  // sees the new token under the old revision (restart reconciliation does NOT
  // filter on revokedAt) would broadcast the fresh credential with a stale fence,
  // and a delayed uninstall would then pass the CAS and kill it.
  it('a re-install never leaves the fresh token under the old generation', async () => {
    const { app } = withPlatform()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)
    const first = await startInstall(app, agentId)
    await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=c1&state=${first.id}`
    })
    const bot = await prisma.bot.findFirstOrThrow({ where: { slackAppId: PLATFORM.appId } })

    const second = await startInstall(app, agentId)
    await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=c2&state=${second.id}`
    })

    // Both halves advanced as one: token, generation, and its timestamp agree.
    const after = await prisma.bot.findUniqueOrThrow({ where: { id: bot.id }, include: { secret: true } })
    expect(after.credentialRevision).toBe(bot.credentialRevision + 1)
    expect(after.credentialInstalledAt).toBeInstanceOf(Date)
    expect(after.credentialInstalledAt!.getTime()).toBeGreaterThanOrEqual(bot.credentialInstalledAt!.getTime())
    expect(after.secret?.botToken).toBe('xoxb-workspace-token')
    expect(after.revokedAt).toBeNull()
  })

  // The platform bot is NON-shareable (§5.5): one workspace install backs exactly
  // one agent. Re-installing with a DIFFERENT agent selected must not quietly add
  // a second install — that is the cap the classic reuse path answers 409 for.
  it('a re-install aimed at another agent is refused, leaving the original binding intact', async () => {
    const { app } = withPlatform()
    const first = randomUUID()
    await seedAgent(prisma, first)
    const started = await startInstall(app, first)
    await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=c1&state=${started.id}`
    })
    const bot = await prisma.bot.findFirstOrThrow({ where: { slackAppId: PLATFORM.appId } })

    // Same workspace, different target agent.
    const other = randomUUID()
    await seedAgent(prisma, other)
    const second = await startInstall(app, other)
    const cb = await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=c2&state=${second.id}`
    })

    expect(cb.body).toContain('already connected to another agent')
    expect((await status(app, second.id)).json()).toMatchObject({ status: 'failed', failureReason: 'agent_taken' })
    // Exactly one install, still the original agent — the cap held.
    const installs = await prisma.integration.findMany({ where: { botId: bot.id } })
    expect(installs).toHaveLength(1)
    expect(installs[0]).toMatchObject({ agentId: first, status: 'active' })
    // …and the credential still rotated, so the workspace keeps working.
    expect((await prisma.bot.findUniqueOrThrow({ where: { id: bot.id } })).credentialRevision).toBe(2)

    // The §5.5 opt-in: once the user flips the workspace bot SHAREABLE
    // (Settings → Bots), the same re-install ADDS the new agent instead.
    await prisma.bot.update({ where: { id: bot.id }, data: { shareable: true } })
    const third = await startInstall(app, other)
    await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=c3&state=${third.id}`
    })
    expect((await status(app, third.id)).json()).toMatchObject({ status: 'completed', botId: bot.id })
    const widened = await prisma.integration.findMany({ where: { botId: bot.id, status: 'active' } })
    expect(widened.map((i) => i.agentId).sort()).toEqual([first, other].sort())
  })

  // Blocker regression (review #196): two concurrent callbacks targeting the SAME
  // new agent must admit exactly one membership. addBotMembership serializes on
  // the bot row and treats the loser's 'exists' as success, so any interleaving
  // yields one active row and two completed installs.
  it('concurrent duplicate callbacks admit exactly one membership (idempotent per bot+agent)', async () => {
    const { app } = withPlatform()
    const first = randomUUID()
    await seedAgent(prisma, first)
    const started = await startInstall(app, first)
    await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=c1&state=${started.id}`
    })
    const bot = await prisma.bot.findFirstOrThrow({ where: { slackAppId: PLATFORM.appId } })
    await prisma.bot.update({ where: { id: bot.id }, data: { shareable: true } })

    const other = randomUUID()
    await seedAgent(prisma, other)
    const [a, b] = await Promise.all([startInstall(app, other), startInstall(app, other)])
    await Promise.all([
      app.app.inject({ method: 'GET', url: `/api/v1/integrations/slack/platform/callback?code=ca&state=${a.id}` }),
      app.app.inject({ method: 'GET', url: `/api/v1/integrations/slack/platform/callback?code=cb&state=${b.id}` })
    ])

    expect((await status(app, a.id)).json()).toMatchObject({ status: 'completed', botId: bot.id })
    expect((await status(app, b.id)).json()).toMatchObject({ status: 'completed', botId: bot.id })
    // Exactly ONE active membership for the new agent — no duplicate rows/specs.
    expect(await prisma.integration.count({ where: { botId: bot.id, agentId: other, status: 'active' } })).toBe(1)
  })

  // Blocker regression (review #196): a sharing DISABLE serializes with membership
  // admission on the bot row. Here the admission holds the lock and commits a 2nd
  // member; the concurrent disable — whose optimistic pre-check saw only one —
  // must recount under the lock and refuse, never committing shareable=false
  // alongside a two-agent membership.
  it('a sharing disable cannot race a concurrent admission into a non-shareable multi-agent bot', async () => {
    const { app } = withPlatform()
    const first = randomUUID()
    await seedAgent(prisma, first)
    const started = await startInstall(app, first)
    await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=c1&state=${started.id}`
    })
    const bot = await prisma.bot.findFirstOrThrow({ where: { slackAppId: PLATFORM.appId } })
    await prisma.bot.update({ where: { id: bot.id }, data: { shareable: true } })
    const other = randomUUID()
    await seedAgent(prisma, other)

    // The admission side: take the bot-row lock (as addBotMembership does), hold it
    // while the toggle runs into it, then commit the second membership.
    let admit!: () => void
    const gate = new Promise<void>((resolve) => (admit = resolve))
    const admission = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM bot WHERE id = ${bot.id} FOR UPDATE`
      await gate
      await tx.integration.create({
        data: {
          id: randomUUID(),
          orgId: DEFAULT_ORG_ID,
          agentId: other,
          botId: bot.id,
          platform: 'slack',
          name: bot.name
        }
      })
    })
    // The toggle: its optimistic pre-check reads ONE member (the review's stale
    // snapshot), then blocks on the row lock inside BotRepo.update.
    const toggle = app.app.inject({ method: 'PATCH', url: `${ORG}/bots/${bot.id}`, payload: { shareable: false } })
    await awaitLockWaiter() // the toggle is on the lock, so the admission below really is the loser
    admit()
    await admission
    const res = await toggle

    // Whichever side the scheduler ran first, the invariant holds: the disable is
    // refused and the bot stays shareable with both members intact.
    expect(res.statusCode).toBe(409)
    expect((res.json() as { message: string }).message).toMatch(/shared by multiple agents/)
    const after = await prisma.bot.findUniqueOrThrow({ where: { id: bot.id } })
    expect(after.shareable).toBe(true)
    expect(await prisma.integration.count({ where: { botId: bot.id, status: 'active' } })).toBe(2)
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

/**
 * The console polls the install ROW, not the integration list: re-authorizing a
 * workspace an agent already has rotates the token and creates NO integration, so
 * "a new integration appeared" would leave that (common) path polling forever.
 */
describe('GET /integrations/slack/platform-install/:id (completion signal)', () => {
  it('pending → completed across the callback', async () => {
    const { app } = withPlatform()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)
    const started = await startInstall(app, agentId)

    const before = await status(app, started.id)
    expect(before.statusCode).toBe(200)
    expect(before.json()).toMatchObject({ status: 'pending', failureReason: null, botId: null })

    await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=c&state=${started.id}`
    })

    const after = await status(app, started.id)
    const bot = await prisma.bot.findFirstOrThrow({ where: { slackAppId: PLATFORM.appId } })
    expect(after.json()).toMatchObject({ status: 'completed', failureReason: null, botId: bot.id })
  })

  // The regression the integration-list heuristic could not pass.
  it('completes a re-authorization that adds NO new integration', async () => {
    const { app } = withPlatform()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)
    const first = await startInstall(app, agentId)
    await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=c1&state=${first.id}`
    })
    const installCount = await prisma.integration.count()

    // Same workspace, same agent: only the credential rotates.
    const second = await startInstall(app, agentId)
    await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=c2&state=${second.id}`
    })

    expect(await prisma.integration.count()).toBe(installCount) // nothing new to observe…
    expect((await status(app, second.id)).json()).toMatchObject({ status: 'completed' }) // …but it landed
  })

  it('reports the failure reason instead of hanging on pending', async () => {
    const { app, stub } = withPlatform()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)
    const started = await startInstall(app, agentId)
    stub.exchangeResult = { ok: false, error: 'invalid_code' }

    await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=c&state=${started.id}`
    })

    expect((await status(app, started.id)).json()).toMatchObject({ status: 'failed', failureReason: 'error' })
  })

  it('a cross-org workspace grab settles as failed with its own reason', async () => {
    const { app } = withPlatform()
    const otherOrg = await prisma.org.create({ data: { slug: `other-${randomUUID().slice(0, 8)}` } })
    await prisma.bot.create({
      data: {
        id: randomUUID(),
        orgId: otherOrg.id,
        name: 'AgentConnect (Theirs)',
        platform: 'slack',
        transport: 'http',
        shareable: false,
        slackAppId: PLATFORM.appId,
        teamId: 'T0WORKSPACE',
        // What a real platform-app install writes: the callback sets workspaceId
        // from team.id, and PgBotRepo.create projects the demux identity. A row
        // carrying only the per-platform pair is a shape production cannot
        // produce, and fencing against it would prove nothing.
        workspaceId: 'T0WORKSPACE',
        externalAppId: PLATFORM.appId,
        externalTenantId: 'T0WORKSPACE'
      }
    })
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)
    const started = await startInstall(app, agentId)

    await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=c&state=${started.id}`
    })

    expect((await status(app, started.id)).json()).toMatchObject({
      status: 'failed',
      failureReason: 'workspace_taken'
    })
  })

  // Slack sends `?error=access_denied&state=…` — the state is present, so the row
  // must settle. Left pending, the console would poll until the TTL reaper turned
  // it into a 404 and then report "expired" for what was a plain cancellation.
  it('a user denial settles the row as failed/denied, not pending', async () => {
    const { app } = withPlatform()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)
    const started = await startInstall(app, agentId)

    const cb = await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?error=access_denied&state=${started.id}`
    })
    expect(cb.body).toContain('cancelled')

    expect((await status(app, started.id)).json()).toMatchObject({ status: 'failed', failureReason: 'denied' })
    expect(await prisma.bot.count()).toBe(0)
  })

  // `inUseByAgentId` clears with the last install, so both of these look "free"
  // to the generic bot picker. Reusing them through POST /integrations would flip
  // the platform bot to shareable (breaking §5.5) or mint an install on a token
  // Slack already rejects.
  it('the generic reuse path refuses a platform-app bot and a revoked bot', async () => {
    const { app } = withPlatform()
    // The generic reuse route requires a PLACED agent before it reaches the
    // bot checks, so give the reuse target a daemon.
    const daemonId = randomUUID()
    await seedDaemon(prisma, daemonId)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)
    const started = await startInstall(app, agentId)
    await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=c1&state=${started.id}`
    })
    const bot = await prisma.bot.findFirstOrThrow({ where: { slackAppId: PLATFORM.appId } })
    // Free it: remove the install, exactly as the console's "remove integration" does.
    await prisma.integration.deleteMany({ where: { botId: bot.id } })

    const other = randomUUID()
    await seedAgent(prisma, other, { daemonId })
    const reuse = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'slack', agentId: other, botId: bot.id }
    })
    expect(reuse.statusCode).toBe(409)
    expect((reuse.json() as { message: string }).message).toMatch(/one agent per workspace/)
    // Not widened behind our back.
    expect((await prisma.bot.findUniqueOrThrow({ where: { id: bot.id } })).shareable).toBe(false)
    expect(await prisma.integration.count({ where: { botId: bot.id } })).toBe(0)

    // Flipping the bot shareable (the Settings → Bots opt-in) lifts the guard:
    // the platform bot then reuses like any shared http bot.
    await prisma.bot.update({ where: { id: bot.id }, data: { shareable: true } })
    const reuseShared = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'slack', agentId: other, botId: bot.id }
    })
    expect(reuseShared.statusCode).toBe(201)
    expect(await prisma.integration.count({ where: { botId: bot.id, status: 'active', agentId: other } })).toBe(1)

    // A revoked NON-platform bot is refused too — its token is dead.
    const plain = await prisma.bot.create({
      data: {
        id: randomUUID(),
        orgId: DEFAULT_ORG_ID,
        name: 'freed-and-revoked',
        platform: 'slack',
        transport: 'http',
        revokedAt: new Date()
      }
    })
    const reuseRevoked = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'slack', agentId: other, botId: plain.id }
    })
    expect(reuseRevoked.statusCode).toBe(409)
    expect((reuseRevoked.json() as { message: string }).message).toMatch(/uninstalled|revoked/)
  })

  // Shared fixture for the two generic-route concurrency regressions below: the
  // workspace's platform bot flipped shareable, bound to agent A, plus a PLACED
  // reuse target B (the generic route requires placement).
  async function sharedPlatformBotWithTarget(app: HttpApp): Promise<{ botId: string; target: string }> {
    const first = randomUUID()
    await seedAgent(prisma, first)
    const started = await startInstall(app, first)
    await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/platform/callback?code=c1&state=${started.id}`
    })
    const bot = await prisma.bot.findFirstOrThrow({ where: { slackAppId: PLATFORM.appId } })
    await prisma.bot.update({ where: { id: bot.id }, data: { shareable: true } })
    const daemonId = randomUUID()
    await seedDaemon(prisma, daemonId)
    const target = randomUUID()
    await seedAgent(prisma, target, { daemonId })
    return { botId: bot.id, target }
  }

  // Blocker regression (review #196, round 2): the GENERIC reuse admission is
  // atomic with the bot row. Here the disable commits first while the reuse's
  // optimistic checks already read shareable=true — under the lock the admission
  // re-reads and refuses instead of inserting into a non-shareable bot.
  it('generic reuse cannot race a sharing disable into a non-shareable multi-agent bot', async () => {
    const { app } = withPlatform()
    const { botId, target } = await sharedPlatformBotWithTarget(app)

    let disable!: () => void
    const gate = new Promise<void>((resolve) => (disable = resolve))
    const winner = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM bot WHERE id = ${botId} FOR UPDATE`
      await gate
      // The committed effect of PATCH /bots/:id {shareable:false} (1 member ⇒ legal).
      await tx.bot.update({ where: { id: botId }, data: { shareable: false } })
    })
    // Fires while the lock is held: MVCC lets its optimistic reads see the stale
    // shareable=true, then it queues on the row lock inside addBotMembership.
    const reuse = app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'slack', agentId: target, botId }
    })
    await awaitLockWaiter()
    disable()
    await winner
    const res = await reuse

    expect(res.statusCode).toBe(409)
    // One member, still non-shareable — the widened state never committed.
    expect((await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).shareable).toBe(false)
    expect(await prisma.integration.count({ where: { botId, status: 'active' } })).toBe(1)
  })

  // Blocker regression (review #196, round 2): duplicate generic reuse for the
  // same (bot, agent) is idempotent — the loser reports the winner's row as 201.
  it('duplicate generic reuse admits exactly one membership', async () => {
    const { app } = withPlatform()
    const { botId, target } = await sharedPlatformBotWithTarget(app)

    let admitOther!: () => void
    const gate = new Promise<void>((resolve) => (admitOther = resolve))
    const winner = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM bot WHERE id = ${botId} FOR UPDATE`
      await gate
      // The committed effect of a concurrent identical reuse that won the lock.
      await tx.integration.create({
        data: { id: randomUUID(), orgId: DEFAULT_ORG_ID, agentId: target, botId, platform: 'slack', name: 'dup' }
      })
    })
    const reuse = app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'slack', agentId: target, botId }
    })
    await awaitLockWaiter()
    admitOther()
    await winner
    const res = await reuse

    expect(res.statusCode).toBe(201)
    expect((res.json() as { agentId: string }).agentId).toBe(target)
    expect(await prisma.integration.count({ where: { botId, agentId: target, status: 'active' } })).toBe(1)
  })

  // Blocker regression (review #196, round 3): a credential revoke that wins the
  // bot-row lock flips every install AND stamps revokedAt — a queued admission
  // must re-check that stamp under the lock instead of reading the now-empty
  // membership set as "free" and minting a live row on the dead credential.
  it('generic reuse cannot resurrect a bot a concurrent revoke just killed', async () => {
    const { app } = withPlatform()
    const { botId, target } = await sharedPlatformBotWithTarget(app)

    let revoke!: () => void
    const gate = new Promise<void>((resolve) => (revoke = resolve))
    const winner = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM bot WHERE id = ${botId} FOR UPDATE`
      await gate
      // The committed effect of BotCredentialWriter.revoke (bot CAS + install flip).
      await tx.bot.update({ where: { id: botId }, data: { revokedAt: new Date() } })
      await tx.integration.updateMany({ where: { botId, status: 'active' }, data: { status: 'revoked' } })
    })
    // Fires while the lock is held: its optimistic revokedAt check sees the
    // pre-revoke snapshot, then it queues on the row lock inside addBotMembership.
    const reuse = app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'slack', agentId: target, botId }
    })
    await awaitLockWaiter()
    revoke()
    await winner
    const res = await reuse

    expect(res.statusCode).toBe(409)
    expect((res.json() as { message: string }).message).toMatch(/uninstalled|revoked/)
    // Nothing came back alive: the bot stays revoked with zero active installs.
    expect(await prisma.integration.count({ where: { botId, status: 'active' } })).toBe(0)
  })

  it('404s for another org’s install id', async () => {
    const { app } = withPlatform()
    const otherOrg = await prisma.org.create({ data: { slug: `foreign-${randomUUID().slice(0, 8)}` } })
    const row = await prisma.slackPlatformInstall.create({
      data: { id: randomUUID(), orgId: otherOrg.id, agentId: randomUUID() }
    })
    expect((await status(app, row.id)).statusCode).toBe(404)
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
