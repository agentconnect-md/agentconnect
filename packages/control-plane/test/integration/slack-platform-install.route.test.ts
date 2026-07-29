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
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
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
      // Always http (a distributed app has no per-workspace xapp) and always
      // NON-shareable (one workspace install ⇒ exactly one agent, §5.5).
      transport: 'http',
      shareable: false,
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
      where: { slackAppId_teamId: { slackAppId: PLATFORM.appId, teamId: 'T0WORKSPACE' } }
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
        teamId: 'T0WORKSPACE'
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
