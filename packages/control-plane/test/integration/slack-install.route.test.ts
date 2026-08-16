/**
 * Slack config-token AUTO-install funnel + per-user config storage
 * (docs/designs/slack-install-smoothing.md §Tier B).
 *
 * Each user stores their OWN App Configuration token, keyed by (orgId, userId).
 * When the caller has one, start (apps.manifest.create → pending row → OAuth link)
 * uses it — rotating it fresh when stale — so the app belongs to them. Then the
 * unauthenticated OAuth callback (code → bot token, stashed on the row, never handed
 * to the browser), poll, and finalize (validate the pasted app-level token + the
 * OAuth bot token → mint the bot + integration → delete the row). Slack is stubbed;
 * the DB + routes are real.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent, seedDutyGroup } from '../fixtures/seed.js'
import { seedPoolMember } from '../fakes/member-set.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { RelayChannel } from '../../src/ws/relay-registry.js'
import { ControlSender } from '../../src/orchestrator/outbound.js'
import type { IntegrationUpsert } from '@agentconnect.md/protocol'
import type {
  SlackConfigApi,
  SlackAppCreateResult,
  SlackManifestExportResult,
  SlackManifestUpdateResult,
  SlackOAuthExchangeResult,
  SlackRotateResult
} from '../../src/http/slack-config-api.js'
import { PLATFORM_APP_DESCRIPTION } from '../../src/http/platform-app-description.js'
import { SLACK_BOT_SCOPES } from '../../src/http/slack-manifest.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const MEMBER = 'd9999999-9999-4999-8999-999999999999'
const GROUP = '00000000-0000-4000-8000-0000000009e1'
// The PUBLIC form (`/v1` alias mount) — what Slack actually redirects the browser
// to on a direct-hit deploy; the gateway-rewritten arrival at the internal
// `/api/v1/…` mount gets its own test below.
const CALLBACK = '/v1/integrations/slack/oauth/callback'
const ALL_BOT_PLATFORMS = ['slack', 'telegram', 'discord']

function daemonCapabilities(platforms: string[]) {
  return { platforms, runtimes: ['claude'], acp: true, features: [] }
}

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

class SpyControl {
  readonly upserts: Array<{ daemonId: string; u: IntegrationUpsert }> = []
  async integrationUpsert(daemonId: string, u: IntegrationUpsert): Promise<void> {
    this.upserts.push({ daemonId, u })
  }
  async integrationRemove(): Promise<void> {}
}

/** A stub Slack App-management/OAuth API with tweakable results + call capture. */
class StubConfigApi implements SlackConfigApi {
  createResult: SlackAppCreateResult = {
    ok: true,
    app: {
      appId: 'A1TEST',
      clientId: 'cid',
      clientSecret: 'csecret',
      signingSecret: 'ssecret',
      oauthAuthorizeUrl: 'https://slack.com/oauth/v2/authorize?client_id=cid&scope=chat:write'
    }
  }
  exchangeResult: SlackOAuthExchangeResult = {
    ok: true,
    result: { botToken: 'xoxb-from-oauth', appId: 'A1TEST', teamId: 'T1TEST', teamName: 'Acme', botUserId: 'U1' }
  }
  rotateResult: SlackRotateResult = {
    ok: true,
    rotated: {
      accessToken: 'xoxe.xoxp-rotated',
      refreshToken: 'xoxe-rotated',
      accessExpiresAt: new Date(Date.now() + 12 * 3600_000)
    }
  }
  // When non-empty, createApp shifts one result per call (models create → rotate → retry).
  createResultQueue: SlackAppCreateResult[] = []
  createCalls: Array<{ configToken: string; manifest: unknown }> = []
  exchangeCalls: Array<{ clientId: string; clientSecret: string; code: string; redirectUri: string }> = []
  rotateCalls: string[] = []
  async createApp(configToken: string, manifest: unknown): Promise<SlackAppCreateResult> {
    this.createCalls.push({ configToken, manifest })
    return this.createResultQueue.length ? this.createResultQueue.shift()! : this.createResult
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
  async rotateConfigToken(refreshToken: string): Promise<SlackRotateResult> {
    this.rotateCalls.push(refreshToken)
    return this.rotateResult
  }
}

function withFunnel(opts?: {
  appTokenCheck?: 'ok' | 'invalid'
  publicCpUrl?: string | null
  publicRelayUrl?: string
}): {
  app: HttpApp
  spy: SpyControl
  stub: StubConfigApi
} {
  const spy = new SpyControl()
  const stub = new StubConfigApi()
  const publicCpUrl = opts?.publicCpUrl === undefined ? 'https://cp.example' : opts.publicCpUrl
  const app = buildHttpApp(
    prisma,
    {
      ...(publicCpUrl ? { PUBLIC_CP_URL: publicCpUrl } : {}),
      ...(opts?.publicRelayUrl ? { PUBLIC_RELAY_URL: opts.publicRelayUrl } : {}),
      PUBLIC_WEB_URL: 'https://console.example'
    },
    undefined,
    spy as unknown as ControlSender,
    { slackConfigApi: stub, verifySlackAppToken: async () => opts?.appTokenCheck ?? 'ok' }
  )
  running = app
  return { app, spy, stub }
}

/** Register a fake connected relay so `hasConnectedRelay()` is true (the http paths). */
function connectRelay(app: HttpApp): void {
  app.relayReg.add({ relayId: 'r1', send: () => {}, close: () => {} } as RelayChannel)
}

async function placedAgent(platforms = ALL_BOT_PLATFORMS): Promise<string> {
  await seedDaemon(prisma, DAEMON, { capabilities: daemonCapabilities(platforms) })
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON })
  return agentId
}

/** Seed the caller's stored App Configuration token (fresh ⇒ used as-is; stale ⇒
 *  rotated). Keyed to the devAuth principal (DEFAULT_OWNER_ID) so the funnel resolves it. */
async function seedUserConfig(when: 'fresh' | 'stale' = 'fresh'): Promise<void> {
  await prisma.slackUserConfig.create({
    data: {
      orgId: DEFAULT_ORG_ID,
      userId: DEFAULT_OWNER_ID,
      accessToken: 'xoxe.xoxp-stored',
      refreshToken: 'xoxe-stored',
      accessExpiresAt: when === 'fresh' ? new Date(Date.now() + 3600_000) : new Date(Date.now() - 60_000)
    }
  })
}

/** Run start → callback so the pending row has a bot token (bot_ready). */
async function startAndAuthorize(app: HttpApp): Promise<string> {
  const agentId = await placedAgent()
  await seedUserConfig()
  const started = (
    await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/slack/app`,
      payload: { agentId, name: 'acme-bot' }
    })
  ).json() as { installId: string }
  await app.app.inject({ method: 'GET', url: `${CALLBACK}?code=the-code&state=${started.installId}` })
  return started.installId
}

describe('slack auto-install funnel', () => {
  it('POST /app uses the caller’s config token to create the app + a pending row, returns an install URL (no tokens)', async () => {
    const agentId = await placedAgent()
    await prisma.agent.update({
      where: { id: agentId },
      data: { description: 'Helps teammates solve support requests.' }
    })
    await seedUserConfig()
    const { app, stub } = withFunnel()
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/slack/app`,
      payload: { agentId, name: 'acme-bot' }
    })
    expect(res.statusCode).toBe(201)
    const dto = res.json() as { installId: string; appId: string; installUrl: string }
    expect(dto.appId).toBe('A1TEST')
    // The stored (fresh) access token created the app.
    expect(stub.createCalls[0]!.configToken).toBe('xoxe.xoxp-stored')
    expect(stub.rotateCalls).toHaveLength(0) // fresh ⇒ no rotation
    // installUrl pins our state + redirect_uri onto Slack's authorize URL.
    const url = new URL(dto.installUrl)
    expect(url.searchParams.get('state')).toBe(dto.installId)
    // The PUBLIC `/v1` form — the internal `/api/v1` variant would 404 at the edge.
    expect(url.searchParams.get('redirect_uri')).toBe('https://cp.example/v1/integrations/slack/oauth/callback')
    const manifest = stub.createCalls[0]!.manifest as {
      features: { agent_view: { agent_description: string } }
      oauth_config: { redirect_urls: string[] }
    }
    expect(manifest.oauth_config.redirect_urls).toEqual(['https://cp.example/v1/integrations/slack/oauth/callback'])
    expect(manifest.features.agent_view.agent_description).toBe(PLATFORM_APP_DESCRIPTION)
    const row = await prisma.slackInstall.findUnique({ where: { id: dto.installId } })
    expect(row).toMatchObject({ appId: 'A1TEST', clientSecret: 'csecret', botToken: null })
    expect(JSON.stringify(dto)).not.toContain('csecret')
  })

  it('POST /app rotates a STALE stored token before creating the app, persisting the fresh pair', async () => {
    const agentId = await placedAgent()
    await seedUserConfig('stale')
    const { app, stub } = withFunnel()
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/slack/app`,
      payload: { agentId }
    })
    expect(res.statusCode).toBe(201)
    expect(stub.rotateCalls).toEqual(['xoxe-stored']) // rotated the stale refresh token
    expect(stub.createCalls[0]!.configToken).toBe('xoxe.xoxp-rotated') // created with the fresh access token
    // The rotated pair was persisted.
    const cfg = await prisma.slackUserConfig.findUnique({
      where: { orgId_userId: { orgId: DEFAULT_ORG_ID, userId: DEFAULT_OWNER_ID } }
    })
    expect(cfg).toMatchObject({ accessToken: 'xoxe.xoxp-rotated', refreshToken: 'xoxe-rotated' })
  })

  it('POST /app is 409 when the caller has NO stored config token', async () => {
    const agentId = await placedAgent()
    const { app } = withFunnel() // no seedUserConfig
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/slack/app`,
      payload: { agentId }
    })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { message: string }).message).toMatch(/stored your Slack App Configuration token/i)
    expect(await prisma.slackInstall.count()).toBe(0)
  })

  it('POST /app on an UNPLACED agent is 409 and creates nothing', async () => {
    const agentId = randomUUID()
    await seedAgent(prisma, agentId) // no daemon
    await seedUserConfig()
    const { app } = withFunnel()
    const res = await app.app.inject({ method: 'POST', url: `${ORG}/integrations/slack/app`, payload: { agentId } })
    expect(res.statusCode).toBe(409)
    expect(await prisma.slackInstall.count()).toBe(0)
  })

  it('POST /app refuses a daemon that has not reported the Slack adapter', async () => {
    const agentId = await placedAgent(['telegram'])
    await seedUserConfig()
    const { app, stub } = withFunnel()

    const res = await app.app.inject({ method: 'POST', url: `${ORG}/integrations/slack/app`, payload: { agentId } })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: 'Conflict', statusCode: 409, message: expect.stringContaining('slack') })
    expect(await prisma.slackInstall.count()).toBe(0)
    expect(stub.createCalls).toHaveLength(0)
  })

  it('POST /app maps a Slack rejection to 400 and an unreachable to 502', async () => {
    const agentId = await placedAgent()
    const { app, stub } = withFunnel()

    await seedUserConfig()
    // Auth rejection on both the create and the durable retry ⇒ 400 (and the config, proven
    // unrecoverable, is invalidated — so the next case re-seeds).
    stub.createResult = { ok: false, error: 'token_expired' }
    const bad = await app.app.inject({ method: 'POST', url: `${ORG}/integrations/slack/app`, payload: { agentId } })
    expect(bad.statusCode).toBe(400)

    await seedUserConfig()
    // unreachable is transient (not an auth error) ⇒ 502, and the config is kept.
    stub.createResult = { ok: false, error: 'unreachable' }
    const down = await app.app.inject({ method: 'POST', url: `${ORG}/integrations/slack/app`, payload: { agentId } })
    expect(down.statusCode).toBe(502)
    expect(await prisma.slackInstall.count()).toBe(0)
    expect(await prisma.slackUserConfig.count()).toBe(1) // transient failure keeps the config
  })

  it('the OAuth callback exchanges the code and stashes the bot token (never in a response)', async () => {
    const { app, stub } = withFunnel()
    const agentId = await placedAgent()
    await seedUserConfig()
    const started = (
      await app.app.inject({ method: 'POST', url: `${ORG}/integrations/slack/app`, payload: { agentId } })
    ).json() as { installId: string }

    const before = await app.app.inject({ method: 'GET', url: `${ORG}/integrations/slack/app/${started.installId}` })
    expect((before.json() as { status: string }).status).toBe('awaiting_oauth')

    const cb = await app.app.inject({ method: 'GET', url: `${CALLBACK}?code=the-code&state=${started.installId}` })
    expect(cb.statusCode).toBe(200)
    expect(cb.headers['content-type']).toContain('text/html')
    expect(cb.body).toContain('Connected to Slack')
    expect(cb.body).not.toContain('xoxb-') // the page carries no token
    expect(stub.exchangeCalls[0]).toMatchObject({
      clientId: 'cid',
      code: 'the-code',
      redirectUri: 'https://cp.example/v1/integrations/slack/oauth/callback'
    })
    const row = await prisma.slackInstall.findUnique({ where: { id: started.installId } })
    expect(row?.botToken).toBe('xoxb-from-oauth')
    const after = await app.app.inject({ method: 'GET', url: `${ORG}/integrations/slack/app/${started.installId}` })
    expect((after.json() as { status: string }).status).toBe('bot_ready')
    expect(after.body).not.toContain('xoxb-')
  })

  it('the callback with an unknown state serves an "expired" page and changes nothing', async () => {
    const { app } = withFunnel()
    const res = await app.app.inject({ method: 'GET', url: `${CALLBACK}?code=x&state=${randomUUID()}` })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('expired')
  })

  it('the callback also serves at the internal /api/v1 mount (where the edge rewrite lands)', async () => {
    const { app } = withFunnel()
    const res = await app.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/slack/oauth/callback?code=x&state=${randomUUID()}`
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('expired')
  })

  it('finalize before the OAuth callback is 409 (bot token not in hand yet)', async () => {
    const { app } = withFunnel()
    const agentId = await placedAgent()
    await seedUserConfig()
    const started = (
      await app.app.inject({ method: 'POST', url: `${ORG}/integrations/slack/app`, payload: { agentId } })
    ).json() as { installId: string }
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/slack/app/${started.installId}/finalize`,
      payload: { appToken: 'xapp-1-A1TEST-9-abc' }
    })
    expect(res.statusCode).toBe(409)
  })

  it('finalize mints the bot + integration from the stored bot token, deletes the pending row, pushes upsert', async () => {
    const { app, spy } = withFunnel()
    const installId = await startAndAuthorize(app)
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/slack/app/${installId}/finalize`,
      payload: { appToken: 'xapp-1-A1TEST-9-abcdef' }
    })
    expect(res.statusCode).toBe(201)
    const dto = res.json() as { id: string; botId: string; name: string }
    expect(dto.name).toBe('acme-bot')
    const secret = await prisma.botSecret.findUnique({ where: { botId: dto.botId } })
    expect(secret).toMatchObject({ botToken: 'xoxb-from-oauth', appToken: 'xapp-1-A1TEST-9-abcdef' })
    const bot = await prisma.bot.findUnique({ where: { id: dto.botId } })
    expect(bot?.slackAppId).toBe('A1TEST')
    expect(await prisma.slackInstall.findUnique({ where: { id: installId } })).toBeNull()
    expect(spy.upserts).toHaveLength(1)
    expect(spy.upserts[0]!.u).toMatchObject({ config: { botToken: 'xoxb-from-oauth' } })
    expect(JSON.stringify(dto)).not.toContain('xoxb-')
  })

  // Slack's initial authorization does not reliably apply every bot permission
  // the manifest declares, and a short grant is SILENT — it only surfaces much
  // later, as a scoped call answering `missing_scope` and the session-access
  // check failing closed. Finalize is the last point where the operator is still
  // in the flow and one reinstall away, so it refuses there.
  // #1026: both funnel legs still gated on `agent.daemonId`, which a POOL agent leaves NULL — so
  // the whole wizard was unreachable for one while its siblings had already been converted.
  it('start and finalize both work for a POOL agent, through the member holding its duty (#1026)', async () => {
    const setId = await seedPoolMember(prisma, MEMBER)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { setId })
    await seedDutyGroup(prisma, GROUP, MEMBER, [agentId])
    await seedUserConfig()
    const { app, spy } = withFunnel()

    const started = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/slack/app`,
      payload: { agentId, name: 'pool-bot' }
    })
    expect({ status: started.statusCode, body: started.json() }).toMatchObject({ status: 201 })
    const { installId } = started.json() as { installId: string }
    await app.app.inject({ method: 'GET', url: `${CALLBACK}?code=the-code&state=${installId}` })

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/slack/app/${installId}/finalize`,
      payload: { appToken: 'xapp-1-A1TEST-9-abcdef' }
    })
    expect({ status: res.statusCode, body: res.json() }).toMatchObject({ status: 201 })
    expect(spy.upserts.map((u) => u.daemonId)).toEqual([MEMBER])
    expect(await prisma.slackInstall.findUnique({ where: { id: installId } })).toBeNull()
  })

  it('start refuses a POOL agent nothing is serving with 409, minting no pending row', async () => {
    const setId = await seedPoolMember(prisma, MEMBER)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { setId })
    await seedUserConfig()
    const { app, stub } = withFunnel()

    const started = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/slack/app`,
      payload: { agentId }
    })
    expect(started.statusCode).toBe(409)
    expect({ created: stub.createCalls, rows: await prisma.slackInstall.count() }).toEqual({ created: [], rows: 0 })
  })

  it('finalize refuses a workspace authorization that granted fewer bot scopes, minting nothing', async () => {
    const { app, spy } = withFunnel()
    const withheld = ['channels:history', 'users:read']
    app.platformStubs.verifySlackBot = async () => ({
      status: 'ok',
      name: 'acme-bot',
      appId: 'A1TEST',
      teamId: 'T_INSTALL',
      teamName: 'Acme',
      botUserId: 'U1',
      scopes: SLACK_BOT_SCOPES.filter((scope) => !withheld.includes(scope))
    })
    const installId = await startAndAuthorize(app)
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/slack/app/${installId}/finalize`,
      payload: { appToken: 'xapp-1-A1TEST-9-abcdef' }
    })

    expect(res.statusCode).toBe(409)
    const body = res.json() as { code: string; message: string; missingScopes: string[] }
    // The list is the point: "reinstall the app" is only actionable when the
    // refusal says WHICH permissions are absent, so the console can render them.
    expect(body.code).toBe('SLACK_MISSING_SCOPES')
    expect(body.missingScopes).toEqual(withheld)
    expect(body.message).toContain('channels:history')
    // No bot, no integration, no daemon push — and the pending row survives, so
    // reinstalling in Slack and retrying Connect is the whole recovery loop.
    expect(await prisma.bot.count({ where: { orgId: DEFAULT_ORG_ID, slackAppId: 'A1TEST' } })).toBe(0)
    expect(await prisma.integration.count({ where: { orgId: DEFAULT_ORG_ID } })).toBe(0)
    expect(spy.upserts).toHaveLength(0)
    expect(await prisma.slackInstall.findUnique({ where: { id: installId } })).not.toBeNull()
  })

  it('finalize installs normally when the workspace granted every required scope', async () => {
    const { app } = withFunnel()
    app.platformStubs.verifySlackBot = async () => ({
      status: 'ok',
      name: 'acme-bot',
      appId: 'A1TEST',
      teamId: 'T_INSTALL',
      teamName: 'Acme',
      botUserId: 'U1',
      // Extra scopes a workspace happens to hold are not a reason to refuse.
      scopes: [...SLACK_BOT_SCOPES, 'bookmarks:read']
    })
    const installId = await startAndAuthorize(app)
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/slack/app/${installId}/finalize`,
      payload: { appToken: 'xapp-1-A1TEST-9-abcdef' }
    })
    expect(res.statusCode).toBe(201)
  })

  // Slack does not always send the `x-oauth-scopes` header. An unreported grant
  // is "we could not tell", NOT "the grant is short" — reading it the other way
  // would start failing installs for a reason unrelated to permissions.
  it('finalize does not refuse when Slack did not report the granted scopes', async () => {
    const { app } = withFunnel()
    app.platformStubs.verifySlackBot = async () => ({
      status: 'ok',
      name: 'acme-bot',
      appId: 'A1TEST',
      teamId: 'T_INSTALL',
      teamName: 'Acme',
      botUserId: 'U1',
      scopes: null
    })
    const installId = await startAndAuthorize(app)
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/slack/app/${installId}/finalize`,
      payload: { appToken: 'xapp-1-A1TEST-9-abcdef' }
    })
    expect(res.statusCode).toBe(201)
  })

  it('finalize refuses a workspace already connected to ANOTHER organization (ingress-tenant-fence.md §5)', async () => {
    const { app } = withFunnel()
    // auth.test resolves the workspace identity — the claim key.
    app.platformStubs.verifySlackBot = async () => ({
      status: 'ok',
      name: 'acme-bot',
      appId: 'A1TEST',
      teamId: 'T1TEST',
      teamName: 'Acme',
      botUserId: 'U1',
      scopes: null
    })
    // Another org already holds a bot for this exact app+workspace: the same
    // signing secret AND the same tenant, which the relay's delivery-time fence
    // cannot tell apart — admission is the only place to stop the second claim.
    const foreignOrgId = `org-claim-${randomUUID().slice(0, 8)}`
    await prisma.org.create({ data: { id: foreignOrgId, slug: foreignOrgId } })
    await prisma.bot.create({
      data: {
        id: randomUUID(),
        orgId: foreignOrgId,
        platform: 'slack',
        name: 'foreign-claim',
        slackAppId: 'A1TEST',
        workspaceId: 'T1TEST'
      }
    })

    const installId = await startAndAuthorize(app)
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/slack/app/${installId}/finalize`,
      payload: { appToken: 'xapp-1-A1TEST-9-abcdef' }
    })
    expect(res.statusCode).toBe(409)
    // The refusal never names the organization holding the workspace.
    expect(res.body).not.toContain(foreignOrgId)
    // Nothing was minted for the caller.
    expect(await prisma.bot.count({ where: { orgId: DEFAULT_ORG_ID, slackAppId: 'A1TEST' } })).toBe(0)
  })

  it('finalize proceeds when the SAME organization already holds the workspace', async () => {
    const { app } = withFunnel()
    app.platformStubs.verifySlackBot = async () => ({
      status: 'ok',
      name: 'acme-bot',
      appId: 'A1TEST',
      teamId: 'T1TEST',
      teamName: 'Acme',
      botUserId: 'U1',
      scopes: null
    })
    // A prior install in the CALLER's org is not a foreign claim.
    await prisma.bot.create({
      data: {
        id: randomUUID(),
        orgId: DEFAULT_ORG_ID,
        platform: 'slack',
        name: 'own-earlier-install',
        slackAppId: 'A1TEST',
        workspaceId: 'T1TEST'
      }
    })

    const installId = await startAndAuthorize(app)
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/slack/app/${installId}/finalize`,
      payload: { appToken: 'xapp-1-A1TEST-9-abcdef' }
    })
    expect(res.statusCode).toBe(201)
  })

  it('finalize (http) mints a relay-ingress bot from the OAuth bot token + captured signing secret — no paste', async () => {
    const { app, spy } = withFunnel()
    const agentId = await placedAgent()
    const installId = randomUUID()
    // A pending HTTP install already through OAuth (bot token stashed). The signing
    // secret was captured from apps.manifest.create at start; finalize needs no paste.
    await prisma.slackInstall.create({
      data: {
        id: installId,
        orgId: DEFAULT_ORG_ID,
        agentId,
        appId: 'A1TEST',
        clientId: 'cid',
        clientSecret: 'csecret',
        botToken: 'xoxb-from-oauth',
        name: 'acme-http',
        transport: 'http',
        signingSecret: 'ssecret'
      }
    })
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/slack/app/${installId}/finalize`,
      payload: { shareable: true } // no app-level token; the shared choice rides the body
    })
    expect(res.statusCode).toBe(201)
    const dto = res.json() as { botId: string }
    const bot = await prisma.bot.findUnique({ where: { id: dto.botId } })
    expect(bot?.transport).toBe('http')
    expect(bot?.shareable).toBe(true) // shareable came from the finalize body, not the row
    expect(bot?.slackAppId).toBe('A1TEST') // the known manifest app id powers the console deep link
    // http credentials: signing secret for the relay, NO xapp on the bot secret.
    const secret = await prisma.botSecret.findUnique({ where: { botId: dto.botId } })
    expect(secret).toMatchObject({ botToken: 'xoxb-from-oauth', appToken: null, signingSecret: 'ssecret' })
    expect(await prisma.slackInstall.findUnique({ where: { id: installId } })).toBeNull()
    // Relay-ingress: the daemon gets no Socket Mode integration/upsert.
    expect(spy.upserts).toHaveLength(0)
  })

  it('POST /app with transport:http is 409 when no relay is available (nothing created)', async () => {
    const { app } = withFunnel()
    const agentId = await placedAgent()
    await seedUserConfig()
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/slack/app`,
      payload: { agentId, transport: 'http' }
    })
    expect(res.statusCode).toBe(409)
    expect(await prisma.slackInstall.count()).toBe(0)
  })

  it('POST /app transport:http creates a pending row carrying the http transport + signing secret, and echoes transport', async () => {
    const { app } = withFunnel({ publicRelayUrl: 'https://relay.example' })
    connectRelay(app)
    const agentId = await placedAgent()
    await seedUserConfig()
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/slack/app`,
      payload: { agentId, transport: 'http' }
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ transport: 'http' }) // the console pins its steps to this
    const row = await prisma.slackInstall.findFirst({ where: { agentId } })
    expect(row).toMatchObject({ transport: 'http', signingSecret: 'ssecret' })
  })

  it('POST /app transport:http REJECTS a create response with no signing secret (502), creating nothing', async () => {
    const { app, stub } = withFunnel({ publicRelayUrl: 'https://relay.example' })
    connectRelay(app)
    // Slack returned a successful app but WITHOUT credentials.signing_secret ⇒ ''.
    stub.createResult = {
      ok: true,
      app: {
        appId: 'A1TEST',
        clientId: 'cid',
        clientSecret: 'csecret',
        signingSecret: '',
        oauthAuthorizeUrl: 'https://slack.com/oauth/v2/authorize?client_id=cid'
      }
    }
    const agentId = await placedAgent()
    await seedUserConfig()
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/slack/app`,
      payload: { agentId, transport: 'http' }
    })
    expect(res.statusCode).toBe(502)
    expect(await prisma.slackInstall.count()).toBe(0) // no unverifiable pending install minted
  })

  it('finalize (http) REFUSES a pending row with no signing secret (409), minting no bot', async () => {
    const { app } = withFunnel()
    const agentId = await placedAgent()
    const installId = randomUUID()
    await prisma.slackInstall.create({
      // http row that (somehow) never captured a signing secret — must not finalize.
      data: {
        id: installId,
        orgId: DEFAULT_ORG_ID,
        agentId,
        appId: 'A1TEST',
        clientId: 'cid',
        clientSecret: 'csecret',
        botToken: 'xoxb-from-oauth',
        name: 'acme-http',
        transport: 'http'
      }
    })
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/slack/app/${installId}/finalize`,
      payload: {}
    })
    expect(res.statusCode).toBe(409)
    expect(await prisma.bot.count()).toBe(0)
  })

  it('finalize is blocked while its agent is moving and keeps the pending credentials', async () => {
    const agentId = await placedAgent()
    await seedUserConfig()
    const { app, spy } = withFunnel()
    const started = (
      await app.app.inject({
        method: 'POST',
        url: `${ORG}/integrations/slack/app`,
        payload: { agentId, name: 'moving-bot' }
      })
    ).json() as { installId: string }
    await app.app.inject({ method: 'GET', url: `${CALLBACK}?code=the-code&state=${started.installId}` })
    const releaseMove = app.deps.agentMutations.tryBeginMove(agentId)!
    try {
      const res = await app.app.inject({
        method: 'POST',
        url: `${ORG}/integrations/slack/app/${started.installId}/finalize`,
        payload: { appToken: 'xapp-1-A1TEST-9-abcdef' }
      })
      expect(res.statusCode).toBe(409)
      expect(await prisma.bot.count()).toBe(0)
      expect(await prisma.integration.count()).toBe(0)
      expect(await prisma.slackInstall.findUnique({ where: { id: started.installId } })).not.toBeNull()
      expect(spy.upserts).toHaveLength(0)
    } finally {
      releaseMove()
    }
  })

  it('finalize rechecks the Slack adapter after the daemon capabilities change', async () => {
    const agentId = await placedAgent()
    await seedUserConfig()
    const { app, spy } = withFunnel()
    const started = (
      await app.app.inject({ method: 'POST', url: `${ORG}/integrations/slack/app`, payload: { agentId } })
    ).json() as { installId: string }
    await app.app.inject({ method: 'GET', url: `${CALLBACK}?code=the-code&state=${started.installId}` })
    await prisma.daemon.update({
      where: { id: DAEMON },
      data: { capabilities: daemonCapabilities([]) }
    })

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/slack/app/${started.installId}/finalize`,
      payload: { appToken: 'xapp-1-A1TEST-9-abcdef' }
    })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: 'Conflict', statusCode: 409, message: expect.stringContaining('slack') })
    expect(await prisma.bot.count()).toBe(0)
    expect(await prisma.integration.count()).toBe(0)
    expect(await prisma.slackInstall.findUnique({ where: { id: started.installId } })).not.toBeNull()
    expect(spy.upserts).toHaveLength(0)
  })

  it('finalize with an app-level token Slack refuses is 400 and keeps the pending row', async () => {
    const { app } = withFunnel({ appTokenCheck: 'invalid' })
    const installId = await startAndAuthorize(app)
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/slack/app/${installId}/finalize`,
      payload: { appToken: 'xapp-1-A1TEST-9-bad' }
    })
    expect(res.statusCode).toBe(400)
    expect(await prisma.integration.count()).toBe(0)
    expect(await prisma.slackInstall.findUnique({ where: { id: installId } })).not.toBeNull()
  })

  it('finalize rejects an app-level token minted for a different Slack app', async () => {
    const { app } = withFunnel()
    const installId = await startAndAuthorize(app)
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/slack/app/${installId}/finalize`,
      payload: { appToken: 'xapp-1-AOTHER-9-abcdef' }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ message: expect.stringContaining('different Slack app') })
    expect(await prisma.integration.count()).toBe(0)
    expect(await prisma.slackInstall.findUnique({ where: { id: installId } })).not.toBeNull()
  })

  it('the funnel routes 404 when PUBLIC_CP_URL / the config API is not configured', async () => {
    const agentId = await placedAgent()
    running = buildHttpApp(prisma) // no PUBLIC_CP_URL, no slackConfigApi ⇒ feature off
    const res = await running.app.inject({ method: 'POST', url: `${ORG}/integrations/slack/app`, payload: { agentId } })
    expect(res.statusCode).toBe(404)
  })
})

describe('slack per-user config storage', () => {
  it('PUT validates by rotating, stores the FRESH pair (not the pasted one), and reports configured', async () => {
    const { app, stub } = withFunnel()
    const res = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/slack/config`,
      payload: { accessToken: 'xoxe.xoxp-pasted', refreshToken: 'xoxe-pasted' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ configured: true, durable: true, autoAvailable: true })
    expect(stub.rotateCalls).toEqual(['xoxe-pasted'])
    // Stored the rotated pair — never the pasted one; and no token leaks to the DTO.
    const row = await prisma.slackUserConfig.findUnique({
      where: { orgId_userId: { orgId: DEFAULT_ORG_ID, userId: DEFAULT_OWNER_ID } }
    })
    expect(row).toMatchObject({ accessToken: 'xoxe.xoxp-rotated', refreshToken: 'xoxe-rotated' })
    expect(JSON.stringify(res.json())).not.toContain('xoxe')
  })

  it('PUT with only the config token stores an access-only row (durable:false, no rotate)', async () => {
    const { app, stub } = withFunnel()
    const res = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/slack/config`,
      payload: { accessToken: 'xoxe.xoxp-access-only' } // no refresh token
    })
    expect(res.statusCode).toBe(200)
    // Usable right now (fresh ~12h access token) even though it isn't durable.
    expect(res.json()).toMatchObject({ configured: true, durable: false, autoAvailable: true })
    expect((res.json() as { accessExpiresAt: string | null }).accessExpiresAt).toBeTruthy()
    expect(stub.rotateCalls).toHaveLength(0) // nothing to rotate
    // Stored the pasted access token as-is with no refresh token.
    const row = await prisma.slackUserConfig.findUnique({
      where: { orgId_userId: { orgId: DEFAULT_ORG_ID, userId: DEFAULT_OWNER_ID } }
    })
    expect(row?.accessToken).toBe('xoxe.xoxp-access-only')
    expect(row?.refreshToken).toBeNull()
    expect(JSON.stringify(res.json())).not.toContain('xoxe')
  })

  it('POST /app is 409 (expired) when only an EXPIRED access-only token is stored', async () => {
    const { app } = withFunnel()
    const agentId = await placedAgent()
    // Access-only, already past expiry ⇒ nothing to rotate ⇒ must re-enter.
    await prisma.slackUserConfig.create({
      data: {
        orgId: DEFAULT_ORG_ID,
        userId: DEFAULT_OWNER_ID,
        accessToken: 'xoxe.xoxp-old',
        refreshToken: null,
        accessExpiresAt: new Date(Date.now() - 60_000)
      }
    })
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/slack/app`,
      payload: { agentId }
    })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { message: string }).message).toMatch(/expired/i)
  })

  it('POST /app DROPS a rejected access-only config (auth error) so the console re-prompts', async () => {
    const { app, stub } = withFunnel()
    stub.createResult = { ok: false, error: 'invalid_auth' } // Slack rejects the token at create
    const agentId = await placedAgent()
    await prisma.slackUserConfig.create({
      data: {
        orgId: DEFAULT_ORG_ID,
        userId: DEFAULT_OWNER_ID,
        accessToken: 'xoxe.xoxp-bad',
        refreshToken: null, // access-only ⇒ no recovery
        accessExpiresAt: new Date(Date.now() + 3600_000) // fresh window, but the token is bad
      }
    })
    const res = await app.app.inject({ method: 'POST', url: `${ORG}/integrations/slack/app`, payload: { agentId } })
    expect(res.statusCode).toBe(400)
    expect(await prisma.slackUserConfig.count()).toBe(0) // dropped ⇒ next status re-prompts
  })

  it('POST /app RECOVERS a durable config on auth rejection by rotating a fresh token and retrying', async () => {
    const { app, stub } = withFunnel()
    // resolve() returns the fresh (unexpired) access token WITHOUT re-validating it, so the
    // first create is rejected. A durable config force-rotates and retries — that succeeds
    // (the 2nd create falls back to the default ok result once the queue drains).
    stub.createResultQueue = [{ ok: false, error: 'invalid_auth' }]
    const agentId = await placedAgent()
    await seedUserConfig() // durable + fresh
    const res = await app.app.inject({ method: 'POST', url: `${ORG}/integrations/slack/app`, payload: { agentId } })
    expect(res.statusCode).toBe(201) // recovered — no re-prompt
    expect(stub.rotateCalls).toEqual(['xoxe-stored']) // forced a rotation despite the fresh window
    expect(stub.createCalls.map((c) => c.configToken)).toEqual(['xoxe.xoxp-stored', 'xoxe.xoxp-rotated'])
    const cfg = await prisma.slackUserConfig.findUnique({
      where: { orgId_userId: { orgId: DEFAULT_ORG_ID, userId: DEFAULT_OWNER_ID } }
    })
    expect(cfg).toMatchObject({ accessToken: 'xoxe.xoxp-rotated', refreshToken: 'xoxe-rotated' }) // fresh pair kept
  })

  it('POST /app INVALIDATES a durable config when even a rotated token is rejected', async () => {
    const { app, stub } = withFunnel()
    stub.createResultQueue = [
      { ok: false, error: 'invalid_auth' }, // stored token rejected
      { ok: false, error: 'invalid_auth' } // rotated token also rejected ⇒ unrecoverable
    ]
    const agentId = await placedAgent()
    await seedUserConfig() // durable + fresh
    const res = await app.app.inject({ method: 'POST', url: `${ORG}/integrations/slack/app`, payload: { agentId } })
    expect(res.statusCode).toBe(400)
    expect(stub.rotateCalls).toEqual(['xoxe-stored']) // attempted recovery before giving up
    expect(await prisma.slackUserConfig.count()).toBe(0) // dropped ⇒ next status re-prompts
  })

  it('PUT maps a rotate rejection to 400 and stores nothing', async () => {
    const { app, stub } = withFunnel()
    stub.rotateResult = { ok: false, error: 'invalid_refresh_token' }
    const res = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/slack/config`,
      payload: { accessToken: 'x', refreshToken: 'bad' }
    })
    expect(res.statusCode).toBe(400)
    expect(await prisma.slackUserConfig.count()).toBe(0)
  })

  it('GET reflects configured/autoAvailable; DELETE clears it', async () => {
    const { app } = withFunnel()
    const empty = await app.app.inject({ method: 'GET', url: `${ORG}/slack/config` })
    expect(empty.json()).toMatchObject({ configured: false, autoAvailable: false })

    await app.app.inject({
      method: 'PUT',
      url: `${ORG}/slack/config`,
      payload: { accessToken: 'a', refreshToken: 'r' }
    })
    const set = await app.app.inject({ method: 'GET', url: `${ORG}/slack/config` })
    expect(set.json()).toMatchObject({ configured: true, autoAvailable: true })

    const del = await app.app.inject({ method: 'DELETE', url: `${ORG}/slack/config` })
    expect(del.statusCode).toBe(204)
    expect(await prisma.slackUserConfig.count()).toBe(0)
  })

  it('autoAvailable is false (but storing still works) when the funnel callback is not configured', async () => {
    const { app } = withFunnel({ publicCpUrl: null }) // config API present, no PUBLIC_CP_URL
    const res = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/slack/config`,
      payload: { accessToken: 'a', refreshToken: 'r' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ configured: true, autoAvailable: false })
  })
})
