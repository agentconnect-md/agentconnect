/** The Google Chat provider against real Postgres (google-chat-integration.md §3): both credential holders, one bot per Chat app. */
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { provisionPresetAgents } from '../../src/persistence/index.js'
import {
  GOOGLE_CHAT_PROBE_URL,
  GOOGLE_TOKEN_ENDPOINT,
  googleCloudProjectUrl
} from '../../src/platforms/googlechat/credential.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import type { RelayChannel } from '../../src/ws/relay-registry.js'
import type { IntegrationRemove, IntegrationUpsert } from '@agentconnect.md/protocol'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const PROJECT_ID = 'example-project'
const PROJECT_NUMBER = '123456789012'
const { privateKey: PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
})
const KEY = JSON.stringify({
  type: 'service_account',
  project_id: PROJECT_ID,
  private_key: PRIVATE_KEY,
  client_email: `agentconnect-chat@${PROJECT_ID}.iam.gserviceaccount.com`
})
const DEPLOYMENT_APP = { projectId: PROJECT_ID, projectNumber: PROJECT_NUMBER, serviceAccountKey: KEY }
const CRM_URL = googleCloudProjectUrl(PROJECT_ID)

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

class SpyControl {
  readonly upserts: IntegrationUpsert[] = []
  async integrationUpsert(_daemonId: string, u: IntegrationUpsert): Promise<void> {
    this.upserts.push(u)
  }
  async integrationRemove(_daemonId: string, _r: IntegrationRemove): Promise<void> {}
}

/** Google's token endpoint, the project read, and one Chat API read; anything else, including a message send, fails. */
function fakeGoogle(calls: string[]): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    calls.push(`${init.method ?? 'GET'} ${url}`)
    if (url === GOOGLE_TOKEN_ENDPOINT) return Response.json({ access_token: 'synthetic-access-token' })
    if (url === CRM_URL) return Response.json({ projectNumber: PROJECT_NUMBER, projectId: PROJECT_ID })
    if (url === GOOGLE_CHAT_PROBE_URL) return Response.json({ spaces: [] })
    throw new Error(`unexpected request to ${url}`)
  }) as typeof fetch
}

function harness(opts: { deploymentApp?: boolean } = {}) {
  const control = new SpyControl()
  const googleCalls: string[] = []
  const relaySends: { type: string; payload: unknown }[] = []
  const app = buildHttpApp(
    prisma,
    { PUBLIC_RELAY_URL: 'https://relay.example.test' },
    undefined,
    control as unknown as ControlSender,
    {
      googleChatFetch: fakeGoogle(googleCalls),
      ...(opts.deploymentApp ? { googleChatPlatformApp: DEPLOYMENT_APP } : {})
    }
  )
  app.relayReg.add({
    relayId: 'r1',
    send: (type: string, payload: unknown) => relaySends.push({ type, payload }),
    close() {}
  } as unknown as RelayChannel)
  running = app
  return { app, control, googleCalls, relaySends }
}

async function placedAgent(): Promise<string> {
  await seedDaemon(prisma, DAEMON, {
    capabilities: { platforms: ['slack', 'googlechat'], runtimes: ['claude'], acp: true, features: [] }
  })
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON })
  return agentId
}

describe('a per-agent Chat app from POST /integrations', () => {
  it('validates the key, stores it write-only, and projects the identity, spec, and relay assignment', async () => {
    const agentId = await placedAgent()
    const { app, control, googleCalls, relaySends } = harness()

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'googlechat', agentId, transport: 'http', googlechat: DEPLOYMENT_APP }
    })
    expect(res.statusCode).toBe(201)
    expect(res.body).not.toContain('PRIVATE KEY')
    expect(googleCalls).toEqual([
      `POST ${GOOGLE_TOKEN_ENDPOINT}`,
      `GET ${CRM_URL}`,
      `POST ${GOOGLE_TOKEN_ENDPOINT}`,
      `GET ${GOOGLE_CHAT_PROBE_URL}`
    ])
    const dto = res.json() as { botId: string; name: string }
    expect(dto.name).toBe(`Google Chat · ${PROJECT_ID}`)

    expect(await prisma.bot.findUnique({ where: { id: dto.botId } })).toMatchObject({
      platform: 'googlechat',
      transport: 'http',
      shareable: false,
      prebuilt: false,
      externalAppId: PROJECT_NUMBER,
      externalTenantId: '-',
      platformConfig: { projectId: PROJECT_ID }
    })
    expect(await prisma.botSecret.findUnique({ where: { botId: dto.botId } })).toMatchObject({
      botToken: KEY,
      appToken: null,
      signingSecret: null
    })

    const assign = relaySends.find((send) => send.type === 'rc/bot-assign')?.payload as {
      platform: string
      ingress: unknown
      secrets: unknown
    }
    expect(assign).toMatchObject({ platform: 'googlechat', ingress: { apiAppId: PROJECT_NUMBER }, secrets: {} })
    expect(JSON.stringify(assign)).not.toContain('PRIVATE KEY')

    expect(control.upserts).toHaveLength(1)
    expect(control.upserts[0]).toMatchObject({
      platform: 'googlechat',
      core: { mode: 'shared' },
      config: { projectId: PROJECT_ID, projectNumber: PROJECT_NUMBER, serviceAccountKey: KEY }
    })
  })

  it('refuses a second bot for the same Chat app', async () => {
    const agentId = await placedAgent()
    const other = randomUUID()
    await seedAgent(prisma, other, { daemonId: DAEMON })
    const { app } = harness()
    const install = (target: string) =>
      app.app.inject({
        method: 'POST',
        url: `${ORG}/integrations`,
        payload: { platform: 'googlechat', agentId: target, transport: 'http', googlechat: DEPLOYMENT_APP }
      })

    expect((await install(agentId)).statusCode).toBe(201)
    const dup = await install(other)
    expect(dup.statusCode).toBe(409)
    expect(dup.json().message).toMatch(/already connected/)
    expect(await prisma.bot.count({ where: { platform: 'googlechat' } })).toBe(1)
  })

  it('refuses an entered number that is not the key’s project, storing nothing', async () => {
    const agentId = await placedAgent()
    const { app } = harness()

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: {
        platform: 'googlechat',
        agentId,
        transport: 'http',
        googlechat: { ...DEPLOYMENT_APP, projectNumber: '210987654321' }
      }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('GOOGLE_CHAT_PROJECT_NUMBER_MISMATCH')
    expect(await prisma.bot.count()).toBe(0)
  })

  it('refuses the socket transport before calling Google', async () => {
    const agentId = await placedAgent()
    const { app, googleCalls } = harness()

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'googlechat', agentId, googlechat: DEPLOYMENT_APP }
    })
    expect(res.statusCode).toBe(400)
    expect(googleCalls).toEqual([])
    expect(await prisma.bot.count()).toBe(0)
  })
})

describe('POST /integrations/googlechat/platform-install', () => {
  const install = (app: HttpApp, payload: Record<string, unknown> = {}) =>
    app.app.inject({ method: 'POST', url: `${ORG}/integrations/googlechat/platform-install`, payload })

  it('404s without a deployment-owned app', async () => {
    const { app } = harness()
    expect((await install(app)).statusCode).toBe(404)
  })

  it('installs the deployment app on the preset agent from the stored key, placement not required', async () => {
    const { app, googleCalls } = harness({ deploymentApp: true })
    await provisionPresetAgents(prisma, { orgId: DEFAULT_ORG_ID })
    const preset = await prisma.agent.findUnique({
      where: { orgId_name: { orgId: DEFAULT_ORG_ID, name: 'agentconnect' } }
    })

    const res = await install(app)
    expect(res.statusCode).toBe(201)
    expect(res.body).not.toContain('PRIVATE KEY')
    expect(res.json()).toMatchObject({ platform: 'googlechat', agentId: preset!.id, channels: [] })
    expect(googleCalls).toHaveLength(4)

    const bot = await prisma.bot.findFirst({ where: { platform: 'googlechat' }, include: { secret: true } })
    expect(bot).toMatchObject({
      prebuilt: true,
      transport: 'http',
      shareable: false,
      externalAppId: PROJECT_NUMBER,
      externalTenantId: '-',
      platformConfig: { projectId: PROJECT_ID }
    })
    expect(bot?.secret?.botToken).toBe(KEY)
  })

  it('installs on a named agent, re-stamps the same bot when run again, and refuses another agent', async () => {
    const agentId = await placedAgent()
    const other = randomUUID()
    await seedAgent(prisma, other, { daemonId: DAEMON })
    const { app, googleCalls } = harness({ deploymentApp: true })

    const first = await install(app, { agentId })
    expect(first.statusCode).toBe(201)
    const { id, botId } = first.json() as { id: string; botId: string }
    const before = await prisma.bot.findUniqueOrThrow({ where: { id: botId } })

    // Running it again is how a rotated deployment key reaches the bot: same bot, same integration, a new generation.
    const again = await install(app, { agentId })
    expect(again.statusCode).toBe(200)
    expect(again.json()).toMatchObject({ id, botId, agentId })
    expect(googleCalls).toHaveLength(8)
    const after = await prisma.bot.findUniqueOrThrow({ where: { id: botId }, include: { secret: true } })
    expect(after.credentialRevision).toBeGreaterThan(before.credentialRevision)
    expect(after.secret?.botToken).toBe(KEY)
    expect(await prisma.bot.count({ where: { platform: 'googlechat' } })).toBe(1)

    const taken = await install(app, { agentId: other })
    expect(taken.statusCode).toBe(409)
    expect(taken.json().message).toMatch(/already connected/)
  })

  it('409s when neither an agentId nor a preset exists', async () => {
    const { app } = harness({ deploymentApp: true })
    const res = await install(app)
    expect(res.statusCode).toBe(409)
    expect(res.json().message).toMatch(/no target agent/)
  })
})
