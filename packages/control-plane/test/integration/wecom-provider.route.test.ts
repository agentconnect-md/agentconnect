/** The WeCom provider against real Postgres: a pasted smart bot, one bot per BotID, and secret replacement without a subscribe. */
import { randomUUID } from 'node:crypto'
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import type { WeComDial } from '../../src/platforms/wecom/provider.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import type { IntegrationRemove, IntegrationUpsert } from '@agentconnect.md/protocol'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd3d3d3d3-dddd-4ddd-8ddd-dddddddddddd'
const BOT_ID = 'aibot-example'
const SECRET = 'secret-placeholder'
const ROTATED = 'secret-placeholder-rotated'

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

/** WeCom's long connection, accepting only BOT_ID with SECRET; each subscribe's BotID is recorded. */
function fakeWeCom(subscribes: string[], closes: { count: number }): WeComDial {
  return (_url, handlers) => {
    queueMicrotask(() => handlers.open())
    return {
      send: (text) => {
        const frame = JSON.parse(text) as { headers: { req_id: string }; body: { bot_id: string; secret: string } }
        subscribes.push(frame.body.bot_id)
        const errcode = frame.body.bot_id === BOT_ID && frame.body.secret === SECRET ? 0 : 853000
        queueMicrotask(() => handlers.message(JSON.stringify({ headers: frame.headers, errcode, errmsg: 'example' })))
      },
      close: () => {
        closes.count++
      }
    }
  }
}

function harness() {
  const control = new SpyControl()
  const subscribes: string[] = []
  const closes = { count: 0 }
  const app = buildHttpApp(prisma, {}, undefined, control as unknown as ControlSender, {
    weComDial: fakeWeCom(subscribes, closes)
  })
  running = app
  return { app, control, subscribes, closes }
}

async function placedAgent(): Promise<string> {
  await seedDaemon(prisma, DAEMON, {
    capabilities: { platforms: ['wecom'], runtimes: ['claude'], acp: true, features: [] }
  })
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON })
  return agentId
}

const install = (app: HttpApp, agentId: string, secret = SECRET, transport?: 'http') =>
  app.app.inject({
    method: 'POST',
    url: `${ORG}/integrations`,
    payload: {
      platform: 'wecom',
      agentId,
      ...(transport ? { transport } : {}),
      wecom: { botId: BOT_ID, secret }
    }
  })

describe('a WeCom smart bot from POST /integrations', () => {
  it('subscribes once, stores the secret write-only, and pushes the daemon config', async () => {
    const agentId = await placedAgent()
    const { app, control, subscribes, closes } = harness()

    const res = await install(app, agentId)
    expect(res.statusCode).toBe(201)
    expect(res.body).not.toContain(SECRET)
    expect(subscribes).toEqual([BOT_ID])
    expect(closes.count).toBe(1)
    const dto = res.json() as { botId: string; name: string }
    expect(dto.name).toBe(`WeCom · ${BOT_ID}`)

    expect(await prisma.bot.findUnique({ where: { id: dto.botId } })).toMatchObject({
      platform: 'wecom',
      transport: 'socket',
      externalAppId: BOT_ID,
      externalTenantId: '-'
    })
    expect(await prisma.botSecret.findUnique({ where: { botId: dto.botId } })).toMatchObject({
      botToken: SECRET,
      appToken: BOT_ID,
      signingSecret: null
    })
    expect(control.upserts).toHaveLength(1)
    expect(control.upserts[0]).toMatchObject({ platform: 'wecom', config: { botId: BOT_ID, secret: SECRET } })
  })

  it('refuses rejected credentials with their own code, storing nothing', async () => {
    const agentId = await placedAgent()
    const { app } = harness()

    const res = await install(app, agentId, 'wrong-secret')
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('WECOM_CREDENTIALS_INVALID')
    expect(await prisma.bot.count()).toBe(0)
  })

  it('answers unavailable when WeCom cannot be reached, storing nothing', async () => {
    const agentId = await placedAgent()
    const app = buildHttpApp(prisma, {}, undefined, new SpyControl() as unknown as ControlSender)
    running = app

    const res = await install(app, agentId)
    expect(res.statusCode).toBe(503)
    expect(res.json().code).toBe('WECOM_CHECK_UNAVAILABLE')
    expect(await prisma.bot.count()).toBe(0)
  })

  it('refuses a second bot for the same BotID without subscribing again', async () => {
    const agentId = await placedAgent()
    const other = randomUUID()
    await seedAgent(prisma, other, { daemonId: DAEMON })
    const { app, subscribes } = harness()

    expect((await install(app, agentId)).statusCode).toBe(201)
    const dup = await install(app, other)
    expect(dup.statusCode).toBe(409)
    expect(dup.json().code).toBe('WECOM_BOT_ALREADY_INSTALLED')
    expect(dup.json().message).toMatch(/already installed/)
    expect(subscribes).toEqual([BOT_ID])
    expect(await prisma.bot.count({ where: { platform: 'wecom' } })).toBe(1)
  })

  it('reuses an existing bot without subscribing', async () => {
    const agentId = await placedAgent()
    const { app, subscribes } = harness()
    const created = (await install(app, agentId)).json() as { id: string; botId: string }
    expect(
      (await app.app.inject({ method: 'DELETE', url: `${ORG}/integrations/${created.id}` })).statusCode
    ).toBeLessThan(300)

    const reused = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'wecom', agentId, botId: created.botId }
    })
    expect(reused.statusCode).toBe(201)
    expect(subscribes).toEqual([BOT_ID])
  })

  it('refuses the http transport before dialing WeCom', async () => {
    const agentId = await placedAgent()
    const { app, subscribes } = harness()

    expect((await install(app, agentId, SECRET, 'http')).statusCode).toBe(400)
    expect(subscribes).toEqual([])
    expect(await prisma.bot.count()).toBe(0)
  })
})

describe('PUT /bots/:id/wecom/credentials', () => {
  it('stores a replaced secret without subscribing, then re-pushes the daemon config', async () => {
    const agentId = await placedAgent()
    const { app, control, subscribes } = harness()
    const { botId } = (await install(app, agentId)).json() as { botId: string }

    const res = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/bots/${botId}/wecom/credentials`,
      payload: { secret: ROTATED }
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain(ROTATED)
    expect(subscribes).toEqual([BOT_ID])
    expect(await prisma.botSecret.findUnique({ where: { botId } })).toMatchObject({
      botToken: ROTATED,
      appToken: BOT_ID
    })
    expect(control.upserts.at(-1)).toMatchObject({ platform: 'wecom', config: { botId: BOT_ID, secret: ROTATED } })
  })

  it('refuses a blank secret', async () => {
    const agentId = await placedAgent()
    const { app } = harness()
    const { botId } = (await install(app, agentId)).json() as { botId: string }
    const res = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/bots/${botId}/wecom/credentials`,
      payload: { secret: '  ' }
    })
    expect(res.statusCode).toBe(400)
  })

  it('answers 404 for a bot it does not know', async () => {
    const { app } = harness()
    const res = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/bots/${randomUUID()}/wecom/credentials`,
      payload: { secret: ROTATED }
    })
    expect(res.statusCode).toBe(404)
  })
})
