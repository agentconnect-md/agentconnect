/** The DingTalk provider against real Postgres (dingtalk-integration.md §2): a pasted internal app, one bot per app, and secret rotation. */
import { randomUUID } from 'node:crypto'
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { DINGTALK_TOKEN_URLS } from '../../src/platforms/dingtalk/provider.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import type { IntegrationRemove, IntegrationUpsert } from '@agentconnect.md/protocol'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd'
const CLIENT_ID = 'dingexampleclient'
const SECRET = 'example-client-secret'
const ROTATED = 'example-rotated-secret'

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

/** DingTalk's token endpoints, accepting only the secrets in `valid`, and an app list naming the robot; anything else fails the test. */
function fakeDingTalk(valid: Set<string>, calls: string[]): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    if (url.endsWith('/v1.0/microApp/allInnerApps'))
      return Response.json({ appList: [{ robotInfo: { name: 'Example Robot', robotCode: CLIENT_ID } }] })
    if (!Object.values(DINGTALK_TOKEN_URLS).includes(url)) throw new Error(`unexpected request to ${url}`)
    const body = JSON.parse(String(init.body)) as { appKey: string; appSecret: string }
    calls.push(body.appKey)
    if (body.appKey === CLIENT_ID && valid.has(body.appSecret))
      return Response.json({ accessToken: 'example-access-token', expireIn: 7200 })
    return Response.json({ code: 'invalidClientIdOrSecret', message: 'invalid' }, { status: 400 })
  }) as typeof fetch
}

function harness() {
  const control = new SpyControl()
  const calls: string[] = []
  const valid = new Set([SECRET, ROTATED])
  const app = buildHttpApp(prisma, {}, undefined, control as unknown as ControlSender, {
    dingTalkFetch: fakeDingTalk(valid, calls)
  })
  running = app
  return { app, control, calls }
}

async function placedAgent(): Promise<string> {
  await seedDaemon(prisma, DAEMON, {
    capabilities: { platforms: ['dingtalk'], runtimes: ['claude'], acp: true, features: [] }
  })
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON })
  return agentId
}

const install = (app: HttpApp, agentId: string, clientSecret = SECRET, transport?: 'http') =>
  app.app.inject({
    method: 'POST',
    url: `${ORG}/integrations`,
    payload: {
      platform: 'dingtalk',
      agentId,
      ...(transport ? { transport } : {}),
      dingtalk: { clientId: CLIENT_ID, clientSecret }
    }
  })

describe('a DingTalk app from POST /integrations', () => {
  it('checks the credentials, stores the secret write-only, and pushes the daemon config', async () => {
    const agentId = await placedAgent()
    const { app, control, calls } = harness()

    const res = await install(app, agentId)
    expect(res.statusCode).toBe(201)
    expect(res.body).not.toContain(SECRET)
    expect(calls).toEqual([CLIENT_ID])
    const dto = res.json() as { botId: string; name: string }
    expect(dto.name).toBe(`DingTalk · ${CLIENT_ID}`)

    expect(await prisma.bot.findUnique({ where: { id: dto.botId } })).toMatchObject({
      name: 'Example Robot',
      platform: 'dingtalk',
      transport: 'socket',
      externalAppId: CLIENT_ID,
      externalTenantId: '-'
    })
    expect(await prisma.botSecret.findUnique({ where: { botId: dto.botId } })).toMatchObject({
      botToken: SECRET,
      appToken: CLIENT_ID,
      signingSecret: null
    })
    expect(control.upserts).toHaveLength(1)
    expect(control.upserts[0]).toMatchObject({
      platform: 'dingtalk',
      config: { clientId: CLIENT_ID, clientSecret: SECRET }
    })
  })

  it('refuses rejected credentials with their own code, storing nothing', async () => {
    const agentId = await placedAgent()
    const { app } = harness()

    const res = await install(app, agentId, 'wrong-secret')
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('DINGTALK_CREDENTIALS_INVALID')
    expect(await prisma.bot.count()).toBe(0)
  })

  it('refuses a second bot for the same app', async () => {
    const agentId = await placedAgent()
    const other = randomUUID()
    await seedAgent(prisma, other, { daemonId: DAEMON })
    const { app } = harness()

    expect((await install(app, agentId)).statusCode).toBe(201)
    const dup = await install(app, other)
    expect(dup.statusCode).toBe(409)
    expect(dup.json().message).toMatch(/already installed/)
    expect(await prisma.bot.count({ where: { platform: 'dingtalk' } })).toBe(1)
  })

  it('refuses the http transport before calling DingTalk', async () => {
    const agentId = await placedAgent()
    const { app, calls } = harness()

    expect((await install(app, agentId, SECRET, 'http')).statusCode).toBe(400)
    expect(calls).toEqual([])
    expect(await prisma.bot.count()).toBe(0)
  })
})

describe('PUT /bots/:id/dingtalk/credentials', () => {
  it('checks and stores a rotated secret, then re-pushes the daemon config', async () => {
    const agentId = await placedAgent()
    const { app, control } = harness()
    const { botId } = (await install(app, agentId)).json() as { botId: string }

    const bad = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/bots/${botId}/dingtalk/credentials`,
      payload: { clientSecret: 'wrong-secret' }
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('DINGTALK_CREDENTIALS_INVALID')

    const res = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/bots/${botId}/dingtalk/credentials`,
      payload: { clientSecret: ROTATED }
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain(ROTATED)
    expect(await prisma.botSecret.findUnique({ where: { botId } })).toMatchObject({
      botToken: ROTATED,
      appToken: CLIENT_ID
    })
    expect(control.upserts.at(-1)).toMatchObject({
      platform: 'dingtalk',
      config: { clientId: CLIENT_ID, clientSecret: ROTATED }
    })
  })

  it('answers 404 for a bot of another platform', async () => {
    const { app } = harness()
    const res = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/bots/${randomUUID()}/dingtalk/credentials`,
      payload: { clientSecret: ROTATED }
    })
    expect(res.statusCode).toBe(404)
  })
})
