/** The Microsoft Teams provider against real Postgres (teams-integration.md §2, §5): a pasted bot registration, one bot per app, secret rotation, and the app package. */
import { randomUUID } from 'node:crypto'
import { describe, it, expect, afterEach } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { msTeamsTokenUrl } from '../../src/platforms/msteams/provider.js'
import { msTeamsPackageId } from '../../src/platforms/msteams/app-package.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import type { RelayChannel } from '../../src/ws/relay-registry.js'
import type { IntegrationRemove, IntegrationUpsert } from '@agentconnect.md/protocol'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd3d3d3d3-dddd-4ddd-8ddd-dddddddddddd'
const APP_ID = '00000000-0000-4000-8000-0000000000a1'
const TENANT_ID = '00000000-0000-4000-8000-0000000000b2'
const SECRET = 'example-client-secret'
const ROTATED = 'example-rotated-secret'
const RELAY = 'https://relay.example.test'

let running: HttpApp[] = []
afterEach(async () => {
  for (const app of running) await app.close()
  running = []
})

class SpyControl {
  readonly upserts: IntegrationUpsert[] = []
  async integrationUpsert(_daemonId: string, u: IntegrationUpsert): Promise<void> {
    this.upserts.push(u)
  }
  async integrationRemove(_daemonId: string, _r: IntegrationRemove): Promise<void> {}
}

/** The tenant's token endpoint, accepting only the secrets in `valid`; any other request fails the test. */
function fakeEntra(valid: Set<string>, calls: string[]): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    if (url !== msTeamsTokenUrl(TENANT_ID)) throw new Error(`unexpected request to ${url}`)
    const body = new URLSearchParams(String(init.body))
    calls.push(body.get('client_id') ?? '')
    if (body.get('client_id') === APP_ID && valid.has(body.get('client_secret') ?? ''))
      return Response.json({ token_type: 'Bearer', expires_in: 3599, access_token: 'example-access-token' })
    return Response.json(
      { error: 'invalid_client', error_description: 'AADSTS7000215: example', error_codes: [7000215] },
      { status: 401 }
    )
  }) as typeof fetch
}

function harness(opts: { relay?: boolean } = { relay: true }) {
  const control = new SpyControl()
  const calls: string[] = []
  const relaySends: { type: string; payload: unknown }[] = []
  const app = buildHttpApp(
    prisma,
    opts.relay ? { PUBLIC_RELAY_URL: RELAY } : {},
    undefined,
    control as unknown as ControlSender,
    { msTeamsFetch: fakeEntra(new Set([SECRET, ROTATED]), calls) }
  )
  app.relayReg.add({
    relayId: 'r1',
    send: (type: string, payload: unknown) => relaySends.push({ type, payload }),
    close() {}
  } as unknown as RelayChannel)
  running.push(app)
  return { app, control, calls, relaySends }
}

async function placedAgent(name = 'Example agent'): Promise<string> {
  await seedDaemon(prisma, DAEMON, {
    capabilities: { platforms: ['msteams'], runtimes: ['claude'], acp: true, features: [] }
  })
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON, name })
  return agentId
}

const install = (app: HttpApp, agentId: string, msteams: Record<string, string> = {}, transport = 'http') =>
  app.app.inject({
    method: 'POST',
    url: `${ORG}/integrations`,
    payload: {
      platform: 'msteams',
      agentId,
      transport,
      msteams: { appId: APP_ID.toUpperCase(), tenantId: TENANT_ID.toUpperCase(), clientSecret: SECRET, ...msteams }
    }
  })

describe('a Teams bot from POST /integrations', () => {
  it('checks the credentials, keeps the secret from the relay, and projects the spec and assignment', async () => {
    const agentId = await placedAgent()
    const { app, control, calls, relaySends } = harness()

    const res = await install(app, agentId)
    expect(res.statusCode).toBe(201)
    expect(res.body).not.toContain(SECRET)
    expect(calls).toEqual([APP_ID])
    const dto = res.json() as { botId: string; name: string }
    expect(dto.name).toBe(`Microsoft Teams · ${APP_ID}`)

    expect(await prisma.bot.findUnique({ where: { id: dto.botId } })).toMatchObject({
      platform: 'msteams',
      transport: 'http',
      shareable: false,
      externalAppId: APP_ID,
      externalTenantId: TENANT_ID
    })
    expect(await prisma.botSecret.findUnique({ where: { botId: dto.botId } })).toMatchObject({
      botToken: SECRET,
      appToken: null,
      signingSecret: null
    })

    const assign = relaySends.find((send) => send.type === 'rc/bot-assign')?.payload
    expect(assign).toMatchObject({
      platform: 'msteams',
      ingress: { apiAppId: APP_ID, teamId: TENANT_ID },
      secrets: {}
    })
    expect(JSON.stringify(assign)).not.toContain(SECRET)

    expect(control.upserts).toHaveLength(1)
    expect(control.upserts[0]).toMatchObject({
      platform: 'msteams',
      config: {
        appId: APP_ID,
        tenantId: TENANT_ID,
        clientSecret: SECRET,
        messagesUrl: `${RELAY}/msteams/messages`
      }
    })
  })

  it('refuses a rejected secret with its own code, storing nothing', async () => {
    const agentId = await placedAgent()
    const { app } = harness()

    const res = await install(app, agentId, { clientSecret: 'wrong-secret' })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('MSTEAMS_SECRET_INVALID')
    expect(res.body).not.toContain('wrong-secret')
    expect(await prisma.bot.count()).toBe(0)
  })

  it('refuses a second bot for the same app and tenant', async () => {
    const agentId = await placedAgent()
    const other = randomUUID()
    await seedAgent(prisma, other, { daemonId: DAEMON })
    const { app } = harness()

    expect((await install(app, agentId)).statusCode).toBe(201)
    const dup = await install(app, other, { appId: APP_ID })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().message).toMatch(/already connected/)
    expect(await prisma.bot.count({ where: { platform: 'msteams' } })).toBe(1)
  })

  it('refuses the socket transport before calling Entra', async () => {
    const agentId = await placedAgent()
    const { app, calls } = harness()

    expect((await install(app, agentId, {}, 'socket')).statusCode).toBe(400)
    expect(calls).toEqual([])
    expect(await prisma.bot.count()).toBe(0)
  })
})

describe('PUT /bots/:id/msteams/credentials', () => {
  it('checks and stores a rotated secret, then re-pushes the daemon config', async () => {
    const agentId = await placedAgent()
    const { app, control } = harness()
    const { botId } = (await install(app, agentId)).json() as { botId: string }

    const rotate = (clientSecret: string) =>
      app.app.inject({ method: 'PUT', url: `${ORG}/bots/${botId}/msteams/credentials`, payload: { clientSecret } })
    const bad = await rotate('wrong-secret')
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('MSTEAMS_SECRET_INVALID')
    expect((await prisma.botSecret.findUnique({ where: { botId } }))?.botToken).toBe(SECRET)

    const res = await rotate(ROTATED)
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain(ROTATED)
    expect((await prisma.botSecret.findUnique({ where: { botId } }))?.botToken).toBe(ROTATED)
    expect(control.upserts.at(-1)).toMatchObject({
      platform: 'msteams',
      config: { appId: APP_ID, tenantId: TENANT_ID, clientSecret: ROTATED }
    })
  })

  it('answers 404 for a bot that is not a Teams bot', async () => {
    const { app } = harness()
    const res = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/bots/${randomUUID()}/msteams/credentials`,
      payload: { clientSecret: ROTATED }
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /integrations/:id/msteams/app-package', () => {
  it('returns the zip whose manifest names the bot, the agent, and the relay host', async () => {
    const agentId = await placedAgent('Example Teams agent')
    const { app } = harness()
    const { id } = (await install(app, agentId)).json() as { id: string }

    const res = await app.app.inject({ method: 'GET', url: `${ORG}/integrations/${id}/msteams/app-package` })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/zip')
    expect(res.headers['content-disposition']).toBe('attachment; filename="agentconnect-teams.zip"')
    const files = unzipSync(new Uint8Array(res.rawPayload))
    expect(Object.keys(files).sort()).toEqual(['color.png', 'manifest.json', 'outline.png'])
    const manifest = JSON.parse(strFromU8(files['manifest.json']!)) as Record<string, any>
    expect(manifest).toMatchObject({
      manifestVersion: '1.30',
      id: msTeamsPackageId(APP_ID),
      name: { short: 'Example Teams agent' },
      bots: [{ botId: APP_ID, scopes: ['personal', 'team', 'groupChat'] }],
      validDomains: ['relay.example.test'],
      webApplicationInfo: { id: APP_ID, resource: `api://relay.example.test/${APP_ID}` },
      supportsChannelFeatures: 'tier1'
    })
    expect(strFromU8(files['manifest.json']!)).not.toContain(SECRET)
  })

  it('needs the relay origin, and 404s an unknown integration', async () => {
    const agentId = await placedAgent()
    const { app } = harness()
    const { id } = (await install(app, agentId)).json() as { id: string }

    const { app: noRelay } = harness({ relay: false })
    const refused = await noRelay.app.inject({ method: 'GET', url: `${ORG}/integrations/${id}/msteams/app-package` })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().code).toBe('MSTEAMS_RELAY_ORIGIN_MISSING')

    const missing = await app.app.inject({
      method: 'GET',
      url: `${ORG}/integrations/${randomUUID()}/msteams/app-package`
    })
    expect(missing.statusCode).toBe(404)
  })
})
