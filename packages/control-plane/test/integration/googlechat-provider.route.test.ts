/** The Google Chat provider against real Postgres (google-chat-integration.md §3, §10): per-agent apps, one bot per Chat app, and the claimed deployment app. */
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
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
const DEPLOYMENT_APP = {
  projectId: PROJECT_ID,
  projectNumber: PROJECT_NUMBER,
  serviceAccountKey: KEY
}
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
  return { app, control, googleCalls, relaySends, relay: app.relayReg.get('r1')! }
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

describe('the deployment app is claimed, never installed per agent (§3, §10.4)', () => {
  const install = (app: HttpApp, agentId: string) =>
    app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'googlechat', agentId, transport: 'http', googlechat: DEPLOYMENT_APP }
    })

  it('refuses a per-agent install of the deployment app’s project with 409, storing nothing', async () => {
    const agentId = await placedAgent()
    const { app } = harness({ deploymentApp: true })

    const res = await install(app, agentId)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: 'Conflict', code: 'GOOGLE_CHAT_DEPLOYMENT_APP' })
    expect(res.body).not.toContain('PRIVATE KEY')
    expect(await prisma.bot.count({ where: { platform: 'googlechat' } })).toBe(0)
  })

  it('never assigns a tenantless row of the deployment app’s project to the relay, where the anchor owns its audience', async () => {
    const agentId = await placedAgent()
    const { app, relaySends, relay } = harness()
    // An organization's own install of the project, made before the project became the deployment app.
    const created = await install(app, agentId)
    expect(created.statusCode).toBe(201)
    const { botId } = created.json() as { botId: string }
    expect(relaySends.filter((send) => send.type === 'rc/bot-assign')).toHaveLength(1)

    app.platformStubs.googleChatPlatformApp = DEPLOYMENT_APP
    relaySends.length = 0
    await app.deps.httpBot.syncBot(botId)
    await app.deps.httpBot.replayTo(relay)
    expect(relaySends.map((send) => send.type)).toEqual(['rc/bot-unassign'])
    expect(relaySends[0]!.payload).toMatchObject({ botId })
  })
})

describe('POST /integrations/googlechat/claim (§10.5)', () => {
  const GOOGLE_USER = '100000000000000000009'
  const SPACE = 'spaces/AAAAexample'
  const DM = 'spaces/DDDDexample'
  const REDIRECT = 'https://chat.google.com/api/config_complete_redirect?token=synthetic'
  const CHAT = 'https://chat.googleapis.com/v1'
  // What Google reports for the caller's domain and the Space's customer; each test sets the order it proves.
  let callerDomain = '0000000000'
  let spaceCustomer = 'C0000000000'
  beforeEach(() => {
    callerDomain = '0000000000'
    spaceCustomer = 'C0000000000'
  })

  /** The Chat reads a claim makes with the deployment key: the caller's Space membership, the Space, and a DM's members. */
  function claimGoogle(): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = String(input)
      if (url === GOOGLE_TOKEN_ENDPOINT) return Response.json({ access_token: 'synthetic-access-token' })
      const member = { name: `users/${GOOGLE_USER}`, type: 'HUMAN', domainId: callerDomain }
      if (url === `${CHAT}/${SPACE}/members/${GOOGLE_USER}`) return Response.json({ affiliation: 'INTERNAL', member })
      if (url === `${CHAT}/${SPACE}`) return Response.json({ name: SPACE, customer: `customers/${spaceCustomer}` })
      if (url === `${CHAT}/${DM}/members?pageSize=100`) return Response.json({ memberships: [{ member }] })
      throw new Error(`unexpected request to ${url}`)
    }) as typeof fetch
  }

  async function claimHarness() {
    await provisionPresetAgents(prisma, { orgId: DEFAULT_ORG_ID })
    // A placed preset, so the relay assignment is broadcast rather than deferred to placement.
    await seedDaemon(prisma, DAEMON, {
      capabilities: { platforms: ['googlechat'], runtimes: ['claude'], acp: true, features: [] }
    })
    await prisma.agent.update({
      where: { orgId_name: { orgId: DEFAULT_ORG_ID, name: 'agentconnect' } },
      data: { daemonId: DAEMON }
    })
    await prisma.user.update({ where: { id: DEFAULT_OWNER_ID }, data: { googleAccountId: GOOGLE_USER } })
    const relaySends: { type: string; payload: unknown }[] = []
    const app = buildHttpApp(
      prisma,
      { PUBLIC_RELAY_URL: 'https://relay.example.test' },
      undefined,
      new SpyControl() as unknown as ControlSender,
      { googleChatFetch: claimGoogle(), googleChatPlatformApp: DEPLOYMENT_APP }
    )
    app.relayReg.add({
      relayId: 'r1',
      send: (type: string, payload: unknown) => relaySends.push({ type, payload }),
      close() {}
    } as unknown as RelayChannel)
    running = app
    return { app, relaySends }
  }

  const state = (kind: 'dm' | 'space', redirect: string | null) =>
    Buffer.from(
      JSON.stringify({
        v: 1,
        app: PROJECT_NUMBER,
        space: kind === 'dm' ? DM : SPACE,
        user: `users/${GOOGLE_USER}`,
        kind,
        tenant: kind === 'dm' ? `domains/${callerDomain}` : `customers/${spaceCustomer}`,
        ...(redirect ? { redirect } : {}),
        iat: 1_790_000_000
      })
    ).toString('base64url')

  const claim = (
    app: HttpApp,
    kind: 'dm' | 'space',
    org: string = DEFAULT_ORG_ID,
    redirect: string | null = REDIRECT
  ) =>
    app.app.inject({
      method: 'POST',
      url: `/api/v1/orgs/${org}/integrations/googlechat/claim`,
      payload: { state: state(kind, redirect) }
    })

  /** The latest relay assignment of one bot. */
  const assignOf = (sends: { type: string; payload: unknown }[], botId: string) =>
    (
      sends
        .map((send) => send.payload as { botId?: string; ingress?: Record<string, unknown> })
        .filter((payload, i) => sends[i]!.type === 'rc/bot-assign' && payload.botId === botId)
        .at(-1) ?? {}
    ).ingress

  const customerRows = () =>
    prisma.bot.findMany({ where: { platform: 'googlechat' }, orderBy: { createdAt: 'asc' }, include: { secret: true } })

  it('upgrades a DM’s domain row to its customer when a Space proves the pair', async () => {
    const { app, relaySends } = await claimHarness()

    const created = await claim(app, 'dm', DEFAULT_ORG_ID, null)
    expect(created.statusCode).toBe(201)
    expect(created.json()).toEqual({})
    const [row] = await customerRows()
    expect(row).toMatchObject({
      orgId: DEFAULT_ORG_ID,
      prebuilt: true,
      externalAppId: PROJECT_NUMBER,
      externalTenantId: 'domains/0000000000',
      platformConfig: { projectId: PROJECT_ID, domainIds: '0000000000' }
    })
    expect(row!.secret?.botToken).toBe(KEY)
    expect(assignOf(relaySends, row!.id)).toEqual({ apiAppId: PROJECT_NUMBER, tenantIds: ['domains/0000000000'] })

    const upgraded = await claim(app, 'space')
    expect(upgraded.statusCode).toBe(200)
    expect(upgraded.json()).toEqual({ redirect: REDIRECT })
    const rows = await customerRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: row!.id,
      externalTenantId: 'customers/C0000000000',
      platformConfig: { projectId: PROJECT_ID, domainIds: '0000000000', customerId: 'C0000000000' }
    })
    expect(assignOf(relaySends, row!.id)).toEqual({
      apiAppId: PROJECT_NUMBER,
      tenantIds: ['customers/C0000000000', 'domains/0000000000']
    })
  })

  it('keeps an unrelated customer’s DM on a row of its own, which its Space proof then upgrades', async () => {
    const { app, relaySends } = await claimHarness()

    // Customer A, proven in a Space.
    expect((await claim(app, 'space')).statusCode).toBe(201)
    // A DM from customer B's domain never lands on A's row.
    callerDomain = '0000000005'
    expect((await claim(app, 'dm')).statusCode).toBe(201)
    let rows = await customerRows()
    expect(rows.map((row) => row.externalTenantId)).toEqual(['customers/C0000000000', 'domains/0000000005'])
    // B's own Space proves the pair and upgrades B's row, which then carries B's customer on its assignment.
    spaceCustomer = 'C0000000005'
    expect((await claim(app, 'space')).statusCode).toBe(200)
    rows = await customerRows()
    expect(rows.map((row) => row.externalTenantId)).toEqual(['customers/C0000000000', 'customers/C0000000005'])
    expect(assignOf(relaySends, rows[1]!.id)).toEqual({
      apiAppId: PROJECT_NUMBER,
      tenantIds: ['customers/C0000000005', 'domains/0000000005']
    })
    expect(assignOf(relaySends, rows[0]!.id)).toEqual({
      apiAppId: PROJECT_NUMBER,
      tenantIds: ['customers/C0000000000', 'domains/0000000000']
    })
  })

  it('consolidates a domain row into its customer’s row once a Space proves they are one customer', async () => {
    const { app, relaySends } = await claimHarness()

    // A DM from domain A, then a Space from domain B of the same customer.
    expect((await claim(app, 'dm')).statusCode).toBe(201)
    callerDomain = '0000000001'
    expect((await claim(app, 'space')).statusCode).toBe(201)
    const [domainRow, customerRow] = await customerRows()
    expect(domainRow!.externalTenantId).toBe('domains/0000000000')
    expect(customerRow!.externalTenantId).toBe('customers/C0000000000')
    const retiredInstall = await prisma.integration.findFirstOrThrow({ where: { botId: domainRow!.id } })

    // A Space from domain A folds the domain row into the customer row.
    callerDomain = '0000000000'
    expect((await claim(app, 'space')).statusCode).toBe(200)
    const rows = await customerRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: customerRow!.id,
      externalTenantId: 'customers/C0000000000',
      platformConfig: { projectId: PROJECT_ID, customerId: 'C0000000000', domainIds: '0000000001,0000000000' }
    })
    expect(await prisma.integration.findUnique({ where: { id: retiredInstall.id } })).toBeNull()
    expect(assignOf(relaySends, customerRow!.id)).toEqual({
      apiAppId: PROJECT_NUMBER,
      tenantIds: ['customers/C0000000000', 'domains/0000000001', 'domains/0000000000']
    })
  })

  it('writes nothing while the domain row’s agent is being moved, and consolidates on the retry', async () => {
    const { app, relaySends } = await claimHarness()
    const preset = await prisma.agent.findUniqueOrThrow({
      where: { orgId_name: { orgId: DEFAULT_ORG_ID, name: 'agentconnect' } }
    })

    // A Space from domain B writes the customer row, then a DM from domain A writes a domain row after it.
    callerDomain = '0000000001'
    expect((await claim(app, 'space')).statusCode).toBe(201)
    callerDomain = '0000000000'
    expect((await claim(app, 'dm')).statusCode).toBe(201)
    const [customerRow, domainRow] = await customerRows()
    expect(customerRow!.externalTenantId).toBe('customers/C0000000000')
    expect(domainRow!.externalTenantId).toBe('domains/0000000000')
    const assignBefore = assignOf(relaySends, customerRow!.id)

    // A's Space claim meets a busy lease: nothing is written, the survivor and its assignment are unchanged.
    const releaseMove = app.deps.agentMutations.tryBeginMove(preset.id)!
    const busy = await claim(app, 'space')
    expect(busy.statusCode).toBe(409)
    expect(busy.json().code).toBe('GOOGLE_CHAT_CLAIM_UNAVAILABLE')
    expect(await customerRows()).toMatchObject([
      { id: customerRow!.id, platformConfig: { domainIds: '0000000001' } },
      { id: domainRow!.id, externalTenantId: 'domains/0000000000' }
    ])
    expect(assignOf(relaySends, customerRow!.id)).toEqual(assignBefore)
    releaseMove()

    // The retry takes the lease and finishes the fold.
    expect((await claim(app, 'space')).statusCode).toBe(200)
    const rows = await customerRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: customerRow!.id,
      platformConfig: { customerId: 'C0000000000', domainIds: '0000000001,0000000000' }
    })
    expect(assignOf(relaySends, customerRow!.id)).toEqual({
      apiAppId: PROJECT_NUMBER,
      tenantIds: ['customers/C0000000000', 'domains/0000000001', 'domains/0000000000']
    })
  })

  it('retires a leftover domain row beside a customer row that already lists its domain', async () => {
    const { app } = await claimHarness()

    callerDomain = '0000000001'
    expect((await claim(app, 'space')).statusCode).toBe(201)
    callerDomain = '0000000000'
    expect((await claim(app, 'dm')).statusCode).toBe(201)
    const [customerRow, domainRow] = await customerRows()
    // The state a fold leaves when it stops between merging the domain and retiring its row.
    await prisma.bot.update({
      where: { id: customerRow!.id },
      data: { platformConfig: { projectId: PROJECT_ID, customerId: 'C0000000000', domainIds: '0000000001,0000000000' } }
    })

    expect((await claim(app, 'dm')).statusCode).toBe(200)
    const rows = await customerRows()
    expect(rows.map((row) => row.id)).toEqual([customerRow!.id])
    expect(await prisma.integration.count({ where: { botId: domainRow!.id } })).toBe(0)
  })

  it('refuses a Space proof whose domain is bound to another customer', async () => {
    const { app } = await claimHarness()

    expect((await claim(app, 'space')).statusCode).toBe(201)
    spaceCustomer = 'C0000000007'
    const refused = await claim(app, 'space')
    expect(refused.statusCode).toBe(409)
    expect(refused.json().code).toBe('GOOGLE_CHAT_CLAIM_CONFLICT')
    const rows = await customerRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.platformConfig).toMatchObject({ customerId: 'C0000000000', domainIds: '0000000000' })
  })

  it('refuses the same customer to a second organization', async () => {
    const { app } = await claimHarness()
    const other = await prisma.org.create({ data: { slug: 'second-example-org' } })
    await prisma.membership.create({ data: { orgId: other.id, userId: DEFAULT_OWNER_ID, role: 'owner' } })

    expect((await claim(app, 'space')).statusCode).toBe(201)
    const taken = await claim(app, 'dm', other.id)
    expect(taken.statusCode).toBe(409)
    expect(taken.json().code).toBe('GOOGLE_CHAT_CLAIM_TAKEN')
    expect(taken.body).not.toContain(DEFAULT_ORG_ID)
    expect(await prisma.bot.count({ where: { platform: 'googlechat' } })).toBe(1)
  })
})
