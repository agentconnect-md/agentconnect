/** The personal-WeChat QR login against real Postgres (wechat-integration.md §2.2, §2.3): install, code refresh, reconnect, and refusals. */
import { randomUUID } from 'node:crypto'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import type { WeChatLoginClient, WeChatQrStatus } from '../../src/platforms/wechat/ilink.js'
import type { IntegrationRemove, IntegrationUpsert } from '@agentconnect.md/protocol'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd3d3d3d3-eeee-4eee-8eee-eeeeeeeeeeee'
const TOKEN = 'example-ilink-token'
const USER = 'o9cq80example123456@im.wechat'

let running: HttpApp[] = []
afterEach(async () => {
  for (const app of running) await app.close()
  running = []
  vi.restoreAllMocks()
})

class SpyControl {
  readonly upserts: IntegrationUpsert[] = []
  async integrationUpsert(_daemonId: string, u: IntegrationUpsert): Promise<void> {
    this.upserts.push(u)
  }
  async integrationRemove(_daemonId: string, _r: IntegrationRemove): Promise<void> {}
}

/** iLink answering a scripted status sequence; every new code is numbered. */
function fakeILink(statuses: WeChatQrStatus[]) {
  const calls: { host: string; qrcode: string; verifyCode?: string }[] = []
  let codes = 0
  const client: WeChatLoginClient = {
    newQrCode: async () => {
      codes += 1
      return { qrcode: `qr-${codes}`, qrUrl: `https://liteapp.weixin.qq.com/q/example${codes}` }
    },
    status: async (host, qrcode, verifyCode) => {
      calls.push({ host, qrcode, ...(verifyCode ? { verifyCode } : {}) })
      const next = statuses.shift()
      if (!next) throw new Error('timed out')
      return next
    }
  }
  return { client, calls }
}

function harness(statuses: WeChatQrStatus[]) {
  const control = new SpyControl()
  const ilink = fakeILink(statuses)
  const app = buildHttpApp(prisma, {}, undefined, control as unknown as ControlSender, {
    weChatLoginClient: ilink.client
  })
  running.push(app)
  return { app, control, ilink }
}

async function placedAgent(platforms = ['wechat']): Promise<string> {
  await seedDaemon(prisma, DAEMON, { capabilities: { platforms, runtimes: ['claude'], acp: true, features: [] } })
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON, name: 'Example agent' })
  return agentId
}

const start = (app: HttpApp, payload: Record<string, unknown>) =>
  app.app.inject({ method: 'POST', url: `${ORG}/integrations/wechat/login`, payload })
const poll = (app: HttpApp, id: string, verifyCode?: string) =>
  app.app.inject({
    method: 'GET',
    url: `${ORG}/integrations/wechat/login/${id}${verifyCode ? `?verifyCode=${verifyCode}` : ''}`
  })

const confirmed = (botId: string, botToken = TOKEN): WeChatQrStatus => ({
  status: 'confirmed',
  botToken,
  ilinkBotId: botId,
  ilinkUserId: USER,
  baseUrl: 'https://ilinkai.weixin.qq.com'
})

describe('WeChat QR login', () => {
  it('installs the bot once WeChat confirms, keeping the token on the server', async () => {
    const agentId = await placedAgent()
    const { app, control, ilink } = harness([
      { status: 'wait' },
      { status: 'scaned' },
      { status: 'need_verifycode' },
      confirmed('a1b2c3@im.bot')
    ])
    const begun = await start(app, { agentId })
    expect(begun.statusCode).toBe(201)
    const login = begun.json() as { id: string; status: string; qrUrl: string }
    expect(login).toMatchObject({ status: 'waiting', qrUrl: 'https://liteapp.weixin.qq.com/q/example1' })

    expect((await poll(app, login.id)).json()).toMatchObject({ status: 'waiting' })
    expect((await poll(app, login.id)).json()).toMatchObject({ status: 'scanned' })
    expect((await poll(app, login.id)).json()).toMatchObject({ status: 'verify_code' })
    const done = await poll(app, login.id, '123456')
    expect(done.statusCode).toBe(200)
    const dto = done.json() as { status: string; integrationId: string; botId: string; wechatUserTail: string }
    expect(dto).toMatchObject({ status: 'completed', wechatUserTail: '123456', qrUrl: null })
    expect(done.body).not.toContain(TOKEN)
    expect(ilink.calls.at(-1)).toEqual({ host: 'https://ilinkai.weixin.qq.com', qrcode: 'qr-1', verifyCode: '123456' })

    const bot = await prisma.bot.findUniqueOrThrow({ where: { id: dto.botId } })
    expect(bot).toMatchObject({ platform: 'wechat', transport: 'socket', externalAppId: null })
    expect(bot.platformConfig).toMatchObject({ wechatBotId: 'a1b2c3@im.bot', wechatUserId: USER })
    const integration = await prisma.integration.findUniqueOrThrow({ where: { id: dto.integrationId } })
    expect(integration).toMatchObject({ agentId, botId: dto.botId, platform: 'wechat' })
    expect(control.upserts.at(-1)?.config).toEqual({ botId: 'a1b2c3@im.bot', botToken: TOKEN, boundUserId: USER })

    // The settled row no longer holds the handle or the token.
    const row = await prisma.wechatPendingLogin.findUniqueOrThrow({ where: { id: login.id } })
    expect(row).toMatchObject({ status: 'completed', botToken: null, qrcode: null, targetKey: null })
    expect((await poll(app, login.id)).json()).toMatchObject({ status: 'completed', integrationId: dto.integrationId })
  })

  it.each(['credentials', 'integration', 'publication'] as const)(
    'resumes an interrupted %s write without duplicating the bot',
    async (stage) => {
      const agentId = await placedAgent()
      const { app, control } = harness([confirmed('example@im.bot')])
      const login = (await start(app, { agentId })).json() as { id: string }
      const error = new Error('temporary interruption')
      if (stage === 'credentials') vi.spyOn(app.deps.repos.botSecret, 'put').mockRejectedValueOnce(error)
      if (stage === 'integration') vi.spyOn(app.deps.repos.integration, 'create').mockRejectedValueOnce(error)
      if (stage === 'publication') vi.spyOn(control, 'integrationUpsert').mockRejectedValueOnce(error)
      expect((await poll(app, login.id)).json()).toMatchObject({ status: 'scanned' })
      expect((await poll(app, login.id)).json()).toMatchObject({ status: 'completed' })
      expect(await prisma.bot.count({ where: { platform: 'wechat' } })).toBe(1)
      expect(await prisma.integration.count({ where: { agentId } })).toBe(1)
      expect(control.upserts).toHaveLength(1)
    }
  )

  it('ends an expired code, and a new login offers a fresh one', async () => {
    const agentId = await placedAgent()
    const { app } = harness([{ status: 'expired' }])
    const login = (await start(app, { agentId })).json() as { id: string; expiresAt: string }
    const offered = Date.parse(login.expiresAt) - Date.now()
    expect(offered).toBeGreaterThan(100_000)
    expect(offered).toBeLessThanOrEqual(120_000)
    expect((await poll(app, login.id)).json()).toMatchObject({
      status: 'failed',
      failureReason: 'expired',
      qrUrl: null
    })
    const fresh = (await start(app, { agentId })).json() as { id: string; qrUrl: string }
    expect(fresh.id).not.toBe(login.id)
    expect(fresh.qrUrl).toBe('https://liteapp.weixin.qq.com/q/example2')
  })

  it('follows a redirect host after a scan', async () => {
    const agentId = await placedAgent()
    const { app, ilink } = harness([
      { status: 'scaned_but_redirect', redirectHost: 'sz.ilinkai.weixin.qq.com' },
      { status: 'wait' }
    ])
    const login = (await start(app, { agentId })).json() as { id: string }
    expect((await poll(app, login.id)).json()).toMatchObject({ status: 'scanned' })
    await poll(app, login.id)
    expect(ilink.calls.map((c) => [c.host, c.qrcode])).toEqual([
      ['https://ilinkai.weixin.qq.com', 'qr-1'],
      ['https://sz.ilinkai.weixin.qq.com', 'qr-1']
    ])
  })

  it('reconnects a bot in place with the new bot id and token', async () => {
    const agentId = await placedAgent()
    const { app, control } = harness([confirmed('old@im.bot', 'old-token'), confirmed('new@im.bot', 'new-token')])
    const first = (await start(app, { agentId })).json() as { id: string }
    const installed = (await poll(app, first.id)).json() as { integrationId: string; botId: string }

    const again = await start(app, { agentId, botId: installed.botId })
    expect(again.statusCode).toBe(201)
    const done = (await poll(app, (again.json() as { id: string }).id)).json()
    expect(done).toMatchObject({ status: 'completed', integrationId: installed.integrationId, botId: installed.botId })
    const bot = await prisma.bot.findUniqueOrThrow({ where: { id: installed.botId } })
    expect(bot.platformConfig).toMatchObject({ wechatBotId: 'new@im.bot' })
    expect(await prisma.integration.count({ where: { agentId } })).toBe(1)
    expect(control.upserts.at(-1)?.config).toMatchObject({ botId: 'new@im.bot', botToken: 'new-token' })
  })

  it('reuses an open login and keeps a failed one failed', async () => {
    const agentId = await placedAgent()
    const { app } = harness([{ status: 'verify_code_blocked' }])
    const first = (await start(app, { agentId })).json() as { id: string }
    expect(((await start(app, { agentId })).json() as { id: string }).id).toBe(first.id)
    expect((await poll(app, first.id)).json()).toMatchObject({ status: 'failed', failureReason: 'verify_code_blocked' })
    const next = (await start(app, { agentId })).json() as { id: string }
    expect(next.id).not.toBe(first.id)
  })

  it('refuses an agent whose daemon has WeChat off, and an unknown login', async () => {
    const agentId = await placedAgent(['telegram'])
    const { app } = harness([])
    const refused = await start(app, { agentId })
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ message: expect.stringContaining('WeChat') })
    expect((await poll(app, randomUUID())).statusCode).toBe(404)
  })

  it('refuses pasted credentials on the generic create route', async () => {
    const agentId = await placedAgent()
    const { app } = harness([])
    const created = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations`,
      payload: { platform: 'wechat', agentId, wechat: {} }
    })
    expect(created.statusCode).toBe(400)
  })

  it('installs once when two polls of a confirmed login overlap', async () => {
    const agentId = await placedAgent()
    const { app } = harness([confirmed('twice@im.bot'), confirmed('twice@im.bot')])
    const login = (await start(app, { agentId })).json() as { id: string }
    const [a, b] = await Promise.all([poll(app, login.id), poll(app, login.id)])
    expect([a.statusCode, b.statusCode]).toEqual([200, 200])
    expect(await prisma.bot.count({ where: { platform: 'wechat' } })).toBe(1)
    expect(await prisma.integration.count({ where: { agentId } })).toBe(1)
    expect((await poll(app, login.id)).json()).toMatchObject({ status: 'completed' })
  })

  it('installs once when an expired claim is taken over by another replica', async () => {
    const agentId = await placedAgent()
    const first = harness([confirmed('example@im.bot')])
    const second = harness([])
    const login = (await start(first.app, { agentId })).json() as { id: string }
    let firstReady!: () => void
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      firstReady = resolve
    })
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const create = first.app.deps.repos.bot.create.bind(first.app.deps.repos.bot)
    vi.spyOn(first.app.deps.repos.bot, 'create').mockImplementationOnce(async (input) => {
      firstReady()
      await barrier
      return create(input)
    })
    const oldPoll = Promise.resolve(poll(first.app, login.id))
    await ready
    try {
      await prisma.wechatPendingLogin.update({ where: { id: login.id }, data: { claimedUntil: new Date(0) } })
      expect((await poll(second.app, login.id)).json()).toMatchObject({ status: 'completed' })
    } finally {
      release()
      await oldPoll
    }
    expect(await prisma.bot.count({ where: { platform: 'wechat' } })).toBe(1)
    expect(await prisma.integration.count({ where: { agentId } })).toBe(1)
    expect((await poll(first.app, login.id)).json()).toMatchObject({
      status: 'completed',
      botId: login.id,
      integrationId: login.id
    })
  })

  it('refuses an API key on both login routes', async () => {
    const agentId = await placedAgent()
    const { app } = harness([])
    const personal = (
      await app.app.inject({ method: 'POST', url: '/api/v1/me/keys', payload: { orgId: DEFAULT_ORG_ID } })
    ).json() as { apiKey: string }
    const headers = { authorization: `Bearer ${personal.apiKey}` }
    for (const request of [
      { method: 'POST' as const, url: `${ORG}/integrations/wechat/login`, payload: { agentId } },
      { method: 'GET' as const, url: `${ORG}/integrations/wechat/login/${randomUUID()}` }
    ]) {
      const res = await app.app.inject({ ...request, headers })
      expect(res.statusCode, request.url).toBe(403)
      expect(res.json().message).toBe('interactive sign-in required')
    }
    expect(await prisma.wechatPendingLogin.count()).toBe(0)
  })
})
