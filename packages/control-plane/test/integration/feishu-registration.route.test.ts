import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { IntegrationUpsert } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { ControlSender } from '../../src/orchestrator/outbound.js'
import {
  AGENTCONNECT_FEISHU_EVENTS,
  AGENTCONNECT_FEISHU_SCOPES,
  FeishuAppRegistrationService,
  type FeishuRegisterApp
} from '../../src/http/feishu-registration.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'

let running: HttpApp | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

class SpyControl {
  readonly upserts: Array<{ daemonId: string; spec: IntegrationUpsert }> = []
  async integrationUpsert(daemonId: string, spec: IntegrationUpsert): Promise<void> {
    this.upserts.push({ daemonId, spec })
  }
}

async function placedAgent(): Promise<string> {
  await seedDaemon(prisma, DAEMON, {
    capabilities: { platforms: ['feishu'], runtimes: ['claude'], acp: true, features: [] }
  })
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON, name: 'support-agent' })
  return agentId
}

describe('Feishu/Lark one-click app registration', () => {
  it('opens the official deeplink with AgentConnect scopes, then installs credentials without returning them', async () => {
    const agentId = await placedAgent()
    let options: Parameters<FeishuRegisterApp>[0] | undefined
    const register: FeishuRegisterApp = async (input) => {
      options = input
      input.onQRCodeReady({
        url: 'https://accounts.feishu.cn/device?user_code=SAFE-CODE',
        expireIn: 600
      })
      return {
        client_id: 'cli_oneclick',
        client_secret: 'one-click-secret',
        user_info: { tenant_brand: 'lark' }
      }
    }
    const service = new FeishuAppRegistrationService(register)
    const spy = new SpyControl()
    const app = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender, {
      feishuAppRegistration: service,
      verifyFeishuBot: async () => ({ status: 'ok', name: 'One-click Bot' })
    })
    running = app

    const started = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/feishu/app`,
      // The provider-reported tenant brand must win over this UI fallback.
      payload: { agentId, name: 'AgentConnect Lark', region: 'feishu' }
    })
    expect(started.statusCode).toBe(201)
    const startDto = started.json() as { id: string; authorizationUrl: string }
    expect(startDto.authorizationUrl).toBe('https://accounts.feishu.cn/device?user_code=SAFE-CODE')
    expect(JSON.stringify(startDto)).not.toContain('one-click-secret')
    expect(JSON.stringify(startDto)).not.toContain('cli_oneclick')
    expect(options).toMatchObject({
      source: 'agentconnect',
      createOnly: true,
      appPreset: { name: 'AgentConnect Lark' },
      addons: {
        preset: true,
        scopes: { tenant: [...AGENTCONNECT_FEISHU_SCOPES] },
        events: { items: { tenant: [...AGENTCONNECT_FEISHU_EVENTS] } }
      }
    })
    expect(options?.addons?.scopes?.tenant).toEqual(
      expect.arrayContaining(['contact:user.base:readonly', 'im:chat:read'])
    )

    await vi.waitFor(async () => {
      const polled = await app.app.inject({
        method: 'GET',
        url: `${ORG}/integrations/feishu/app/${startDto.id}`
      })
      expect(polled.statusCode).toBe(200)
      expect(polled.json()).toMatchObject({ status: 'completed', failureReason: null })
      expect(JSON.stringify(polled.json())).not.toContain('one-click-secret')
      expect(JSON.stringify(polled.json())).not.toContain('cli_oneclick')
    })

    const bot = await prisma.bot.findFirst({ where: { feishuAppId: 'cli_oneclick' } })
    expect(bot).toMatchObject({ name: 'AgentConnect Lark', feishuRegion: 'lark' })
    expect(await prisma.botSecret.findUnique({ where: { botId: bot!.id } })).toMatchObject({
      botToken: 'one-click-secret',
      appToken: 'cli_oneclick'
    })
    expect(spy.upserts).toHaveLength(1)
    expect(spy.upserts[0]).toMatchObject({
      daemonId: DAEMON,
      spec: {
        agentId,
        platform: 'feishu',
        feishu: { appId: 'cli_oneclick', appSecret: 'one-click-secret', region: 'lark' }
      }
    })
  })

  it('reports a denied authorization without creating a bot', async () => {
    const agentId = await placedAgent()
    const register: FeishuRegisterApp = async (input) => {
      input.onQRCodeReady({ url: 'https://accounts.feishu.cn/device?user_code=DENIED', expireIn: 600 })
      throw { code: 'access_denied', description: 'denied' }
    }
    const app = buildHttpApp(prisma, undefined, undefined, undefined, {
      feishuAppRegistration: new FeishuAppRegistrationService(register)
    })
    running = app

    const started = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/feishu/app`,
      payload: { agentId }
    })
    expect(started.statusCode).toBe(201)
    const { id } = started.json() as { id: string }

    await vi.waitFor(async () => {
      const polled = await app.app.inject({ method: 'GET', url: `${ORG}/integrations/feishu/app/${id}` })
      expect(polled.json()).toMatchObject({ status: 'failed', failureReason: 'denied', integrationId: null })
    })
    expect(await prisma.bot.count()).toBe(0)
    expect(await prisma.integration.count()).toBe(0)
  })
})
