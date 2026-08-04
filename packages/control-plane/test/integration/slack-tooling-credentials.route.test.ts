/**
 * The §9 `providerToolingCredentials` facet, end to end — the last leftover of
 * the S3 CP adoption (#605 deferred it).
 *
 * Two flows call BACK INTO the Slack platform for the caller's stored App
 * Configuration token, and until now each reached past the provider straight
 * into `http/slack-user-config.ts`:
 *
 *  - the quick-install funnel start, `POST /integrations/slack/app`;
 *  - the Settings→Bots manifest refresh, `POST /bots/:id/slack/refresh`
 *    (which also lived in CORE `routes/bots.ts` and is now provider-contributed).
 *
 * A third — the config STATUS projection, `GET|PUT /slack/config` — computed the
 * same "is it usable right now" verdict inline with `configUsable(row, now)`.
 *
 * WHAT THIS PINS. That all three now answer from ONE store through ONE facet
 * instance, and that the three resolutions the store can return —
 * `not_configured` / `expired` (stale access-only token) / rotated-fresh — reach
 * each caller as the SAME outcome as before the migration. The store is proven
 * to be the authority by writing to it directly (`repos.slackUserConfig`) and by
 * counting the Slack API calls a resolution does or does not spend.
 *
 * It also pins the READ-THROUGH seam the DI collapse depended on: the twelve
 * platform-named `HttpDeps` slots are gone, so suites stub platforms through
 * `app.platformStubs` — and a stub swapped AFTER the app is built must still be
 * observed, because the providers dereference the bag per call instead of
 * capturing its members at composition time.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type {
  SlackConfigApi,
  SlackAppCreateResult,
  SlackManifestExportResult,
  SlackManifestUpdateResult,
  SlackOAuthExchangeResult,
  SlackRotateResult
} from '../../src/http/slack-config-api.js'
import { OrgId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd'
const HOUR = 60 * 60 * 1000

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

/** Records every call so a test can prove which resolution was taken (a rotate
 *  spent vs. not) without reaching into the resolver. */
class CountingConfigApi implements SlackConfigApi {
  createCalls: string[] = []
  exportCalls: string[] = []
  updateCalls: string[] = []
  rotateCalls: string[] = []
  rotateResult: SlackRotateResult = {
    ok: true,
    rotated: {
      accessToken: 'xoxe.xoxp-rotated',
      refreshToken: 'xoxe-rotated-refresh',
      accessExpiresAt: new Date(Date.now() + 12 * HOUR)
    }
  }
  async createApp(configToken: string): Promise<SlackAppCreateResult> {
    this.createCalls.push(configToken)
    return {
      ok: true,
      app: {
        appId: 'A1TOOL',
        clientId: 'cid',
        clientSecret: 'csecret',
        signingSecret: 'ssecret',
        oauthAuthorizeUrl: 'https://slack.com/oauth/v2/authorize?client_id=cid&scope=chat:write'
      }
    }
  }
  async exportApp(configToken: string): Promise<SlackManifestExportResult> {
    this.exportCalls.push(configToken)
    return { ok: true, manifest: { display_information: { name: 'Kept' } } }
  }
  async updateApp(configToken: string): Promise<SlackManifestUpdateResult> {
    this.updateCalls.push(configToken)
    return { ok: true, permissionsUpdated: true }
  }
  async exchangeOAuth(): Promise<SlackOAuthExchangeResult> {
    return { ok: false, error: 'unused' }
  }
  async rotateConfigToken(refreshToken: string): Promise<SlackRotateResult> {
    this.rotateCalls.push(refreshToken)
    return this.rotateResult
  }
}

function withFunnel(): { app: HttpApp; api: CountingConfigApi } {
  const api = new CountingConfigApi()
  const app = buildHttpApp(prisma, { PUBLIC_CP_URL: 'https://cp.example.test' }, undefined, undefined, {
    slackConfigApi: api
  })
  running = app
  return { app, api }
}

async function placedAgent(): Promise<string> {
  await seedDaemon(prisma, DAEMON, {
    capabilities: { platforms: ['slack', 'telegram'], runtimes: ['claude'], acp: true, features: [] }
  })
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON })
  return agentId
}

/** Write the caller's credential straight into the store the facet must read. */
async function storeConfig(
  app: HttpApp,
  row: { accessToken: string; refreshToken: string | null; accessExpiresAt: Date }
): Promise<void> {
  await app.deps.repos.slackUserConfig.put(OrgId(DEFAULT_ORG_ID), DEFAULT_OWNER_ID, row)
}

/** A Slack bot whose app id matches what `verifySlackBot` will claim, so the
 *  refresh route reaches its credential resolution. */
async function installedSlackBot(app: HttpApp, appId: string): Promise<string> {
  const agentId = await placedAgent()
  app.platformStubs.verifySlackBot = async () => ({
    status: 'ok',
    name: 'tooling-bot',
    appId,
    teamId: 'T1',
    teamName: 'Acme',
    scopes: []
  })
  const created = (await app.app.inject({
    method: 'POST',
    url: `${ORG}/integrations`,
    payload: {
      name: 'tooling-bot',
      platform: 'slack',
      agentId,
      slack: { botToken: 'xoxb-tooling', appToken: `xapp-1-${appId}-123-abcdef` }
    }
  })) as { json(): { botId: string } }
  return created.json().botId
}

describe('providerToolingCredentials — the funnel start (POST /integrations/slack/app)', () => {
  it('resolves the caller row from the SlackUserConfig store and spends no rotate on a fresh token', async () => {
    const { app, api } = withFunnel()
    const agentId = await placedAgent()
    await storeConfig(app, {
      accessToken: 'xoxe.xoxp-fresh',
      refreshToken: 'xoxe-refresh',
      accessExpiresAt: new Date(Date.now() + HOUR)
    })

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/slack/app`,
      payload: { agentId, name: 'from-funnel' }
    })

    expect(res.statusCode).toBe(201)
    // The store answered, and its ACCESS token is what created the app.
    expect(api.createCalls).toEqual(['xoxe.xoxp-fresh'])
    expect(api.rotateCalls).toEqual([])
  })

  it('rotates a stale access token through the facet and persists the fresh pair', async () => {
    const { app, api } = withFunnel()
    const agentId = await placedAgent()
    await storeConfig(app, {
      accessToken: 'xoxe.xoxp-stale',
      refreshToken: 'xoxe-refresh',
      // Inside ROTATE_MARGIN_MS ⇒ "stale" even though it has not technically lapsed.
      accessExpiresAt: new Date(Date.now() + 60_000)
    })

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/slack/app`,
      payload: { agentId, name: 'rotated' }
    })

    expect(res.statusCode).toBe(201)
    expect(api.rotateCalls).toEqual(['xoxe-refresh'])
    expect(api.createCalls).toEqual(['xoxe.xoxp-rotated'])
    // …and the rotated pair went BACK to the same store (rotation is single-use).
    expect(await app.deps.repos.slackUserConfig.get(OrgId(DEFAULT_ORG_ID), DEFAULT_OWNER_ID)).toMatchObject({
      accessToken: 'xoxe.xoxp-rotated',
      refreshToken: 'xoxe-rotated-refresh'
    })
  })

  it('refuses with 409 + the not-configured copy when the store holds nothing', async () => {
    const { app, api } = withFunnel()
    const agentId = await placedAgent()

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/slack/app`,
      payload: { agentId, name: 'no-config' }
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().message).toContain('haven’t stored your Slack App Configuration token')
    expect(api.createCalls).toEqual([])
  })

  it('refuses with 409 + the expired copy for a lapsed ACCESS-ONLY token (nothing to rotate)', async () => {
    const { app, api } = withFunnel()
    const agentId = await placedAgent()
    await storeConfig(app, {
      accessToken: 'xoxe.xoxp-lapsed',
      refreshToken: null,
      accessExpiresAt: new Date(Date.now() - HOUR)
    })

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/slack/app`,
      payload: { agentId, name: 'lapsed' }
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().message).toContain('expired')
    expect(api.rotateCalls).toEqual([])
    expect(api.createCalls).toEqual([])
  })
})

describe('providerToolingCredentials — the Settings→Bots manifest refresh', () => {
  it('resolves the same caller row and syncs the manifest with its access token', async () => {
    const { app, api } = withFunnel()
    const botId = await installedSlackBot(app, 'A0TOOL0001')
    await storeConfig(app, {
      accessToken: 'xoxe.xoxp-fresh',
      refreshToken: 'xoxe-refresh',
      accessExpiresAt: new Date(Date.now() + HOUR)
    })

    const res = await app.app.inject({ method: 'POST', url: `${ORG}/bots/${botId}/slack/refresh` })

    expect(res.statusCode).toBe(200)
    expect(res.json().manifest).toBe('synced')
    expect(api.exportCalls).toEqual(['xoxe.xoxp-fresh'])
    expect(api.updateCalls).toEqual(['xoxe.xoxp-fresh'])
    // The token never reaches the browser.
    expect(JSON.stringify(res.json())).not.toContain('xoxe')
  })

  it('degrades to manual_update_required — never 5xx — when the store holds nothing', async () => {
    const { app, api } = withFunnel()
    const botId = await installedSlackBot(app, 'A0TOOL0002')

    const res = await app.app.inject({ method: 'POST', url: `${ORG}/bots/${botId}/slack/refresh` })

    expect(res.statusCode).toBe(200)
    expect(res.json().manifest).toBe('manual_update_required')
    expect(api.exportCalls).toEqual([])
  })

  it('degrades to manual_update_required for a lapsed ACCESS-ONLY token', async () => {
    const { app, api } = withFunnel()
    const botId = await installedSlackBot(app, 'A0TOOL0003')
    await storeConfig(app, {
      accessToken: 'xoxe.xoxp-lapsed',
      refreshToken: null,
      accessExpiresAt: new Date(Date.now() - HOUR)
    })

    const res = await app.app.inject({ method: 'POST', url: `${ORG}/bots/${botId}/slack/refresh` })

    expect(res.statusCode).toBe(200)
    expect(res.json().manifest).toBe('manual_update_required')
    expect(api.rotateCalls).toEqual([])
    expect(api.exportCalls).toEqual([])
  })

  it("reports 'unknown' (not a failed sync) when the rotate cannot reach Slack", async () => {
    const { app, api } = withFunnel()
    const botId = await installedSlackBot(app, 'A0TOOL0004')
    api.rotateResult = { ok: false, error: 'unreachable' }
    await storeConfig(app, {
      accessToken: 'xoxe.xoxp-stale',
      refreshToken: 'xoxe-refresh',
      accessExpiresAt: new Date(Date.now() + 60_000)
    })

    const res = await app.app.inject({ method: 'POST', url: `${ORG}/bots/${botId}/slack/refresh` })

    expect(res.statusCode).toBe(200)
    expect(res.json().manifest).toBe('unknown')
    expect(api.exportCalls).toEqual([])
  })
})

describe('providerToolingCredentials — the config status projection', () => {
  it('reports autoAvailable from the facet, and drops it the moment the store row goes', async () => {
    const { app } = withFunnel()
    await storeConfig(app, {
      accessToken: 'xoxe.xoxp-fresh',
      refreshToken: 'xoxe-refresh',
      accessExpiresAt: new Date(Date.now() + HOUR)
    })

    const usable = await app.app.inject({ method: 'GET', url: `${ORG}/slack/config` })
    expect(usable.json()).toMatchObject({ configured: true, durable: true, funnelEnabled: true, autoAvailable: true })

    await app.app.inject({ method: 'DELETE', url: `${ORG}/slack/config` })
    const gone = await app.app.inject({ method: 'GET', url: `${ORG}/slack/config` })
    expect(gone.json()).toMatchObject({ configured: false, durable: false, autoAvailable: false })
  })

  it('a lapsed access-only token is configured but NOT auto-available', async () => {
    const { app } = withFunnel()
    await storeConfig(app, {
      accessToken: 'xoxe.xoxp-lapsed',
      refreshToken: null,
      accessExpiresAt: new Date(Date.now() - HOUR)
    })

    const res = await app.app.inject({ method: 'GET', url: `${ORG}/slack/config` })

    // `configured` and `autoAvailable` are DIFFERENT questions, and only the
    // second is the facet's: the console still shows the stored token, but the
    // wizard falls back to the manual manifest path.
    expect(res.json()).toMatchObject({ configured: true, durable: false, autoAvailable: false })
  })

  it('keeps the deployment term out of the facet: no PUBLIC_CP_URL ⇒ no auto-install', async () => {
    // The funnel's public callback origin is core's knowledge, not the credential
    // store's — `usableNow` answers only "is the token usable".
    const api = new CountingConfigApi()
    const app = buildHttpApp(prisma, undefined, undefined, undefined, { slackConfigApi: api })
    running = app
    await storeConfig(app, {
      accessToken: 'xoxe.xoxp-fresh',
      refreshToken: 'xoxe-refresh',
      accessExpiresAt: new Date(Date.now() + HOUR)
    })

    const res = await app.app.inject({ method: 'GET', url: `${ORG}/slack/config` })

    expect(res.json()).toMatchObject({ configured: true, durable: true, funnelEnabled: false, autoAvailable: false })
  })
})

describe('the §9 DI collapse keeps its read-through seam', () => {
  it('observes a platform stub swapped AFTER the app is built', async () => {
    // The twelve platform-named `HttpDeps` slots are gone; the providers and their
    // routes are composed from `platformStubs`, which suites mutate post-build.
    // If any seam captured the member at composition time instead of dereferencing
    // it per call, the second response below would still be the first stub's.
    const { app } = withFunnel()
    await placedAgent()

    const probe = () =>
      app.app.inject({ method: 'POST', url: `${ORG}/integrations/telegram/check`, payload: { botToken: '123:abc' } })

    // The harness default: a valid token with Group Privacy Mode already off.
    expect((await probe()).json()).toEqual({ status: 'ready' })

    app.platformStubs.verifyTelegramBot = async () => ({
      status: 'ok',
      name: 'privacy-on',
      privacyModeDisabled: false
    })
    expect((await probe()).json()).toEqual({ status: 'privacy_enabled' })

    app.platformStubs.verifyTelegramBot = async () => ({ status: 'invalid' })
    expect((await probe()).json()).toEqual({ status: 'invalid' })
  })

  it('observes a Slack verifier swapped AFTER the app is built, on a provider-contributed route', async () => {
    const { app } = withFunnel()
    const botId = await installedSlackBot(app, 'A0TOOL0005')

    // `installedSlackBot` left a verifier claiming this exact app id + no scopes.
    expect((await app.app.inject({ method: 'POST', url: `${ORG}/bots/${botId}/slack/refresh` })).json()).toMatchObject({
      authorization: 'reinstall_required'
    })

    app.platformStubs.verifySlackBot = async () => ({ status: 'invalid' })
    expect((await app.app.inject({ method: 'POST', url: `${ORG}/bots/${botId}/slack/refresh` })).json()).toMatchObject({
      authorization: 'invalid'
    })
  })
})
