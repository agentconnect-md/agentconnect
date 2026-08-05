import { afterEach, describe, expect, it, vi } from 'vitest'
import { gunzipSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import type { IntegrationUpsert } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { ControlSender } from '../../src/orchestrator/outbound.js'
import {
  AGENTCONNECT_FEISHU_CALLBACKS,
  AGENTCONNECT_FEISHU_EVENTS,
  AGENTCONNECT_FEISHU_SCOPES
} from '../../src/http/feishu-app-template.js'
import { PLATFORM_APP_DESCRIPTION } from '../../src/http/platform-app-description.js'
import {
  FEISHU_REGISTRATION_DOMAIN,
  LARK_LAUNCHER_DOMAIN,
  OfficialFeishuRegistrationProvider,
  type PollFeishuRegistration,
  type FeishuRegistrationProvider
} from '../../src/http/feishu-registration-provider.js'
import { FeishuAppRegistrationService, FeishuRegistrationConflictError } from '../../src/http/feishu-registration.js'
import { PgFeishuAppRegistrationStore } from '../../src/persistence/index.js'
import { PlaintextSecretCipher } from '../../src/secrets/cipher.js'
import { AgentId, OrgId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import type { RelayChannel } from '../../src/ws/relay-registry.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const UNSUPPORTED_DAEMON = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd'

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

class FlakyControl extends SpyControl {
  override async integrationUpsert(daemonId: string, spec: IntegrationUpsert): Promise<void> {
    await super.integrationUpsert(daemonId, spec)
    if (this.upserts.length === 1) throw new Error('simulated integration push failure')
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

function service(fetcher: typeof fetch): FeishuAppRegistrationService {
  return new FeishuAppRegistrationService(
    new PgFeishuAppRegistrationStore(prisma, new PlaintextSecretCipher()),
    new OfficialFeishuRegistrationProvider(fetcher)
  )
}

function decodeAddons(encoded: string): unknown {
  return JSON.parse(gunzipSync(Buffer.from(encoded, 'base64url')).toString('utf8'))
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('Feishu/Lark one-click app registration', () => {
  it('uses the canonical issuer for a valid Lark launcher link', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          verification_uri_complete: 'https://open.feishu.cn/page/launcher?user_code=LARK',
          device_code: 'lark-device-code',
          expires_in: 600,
          interval: 1
        })
      )
    })
    const begun = await new OfficialFeishuRegistrationProvider(fetcher).begin('AgentConnect Lark', 'lark', {
      avatarUrl: 'https://cdn.example.test/agent.png'
    })

    expect(new URL(String(fetcher.mock.calls[0]![0])).hostname).toBe(FEISHU_REGISTRATION_DOMAIN)
    const authorizationUrl = new URL(begun.authorizationUrl)
    expect(authorizationUrl.hostname).toBe(LARK_LAUNCHER_DOMAIN)
    expect(authorizationUrl.searchParams.get('user_code')).toBe('LARK')
    expect(authorizationUrl.searchParams.get('avatar')).toBe('https://cdn.example.test/agent.png')
    expect(authorizationUrl.searchParams.get('desc')).toBe(PLATFORM_APP_DESCRIPTION)
    expect(begun.providerDomain).toBe(FEISHU_REGISTRATION_DOMAIN)
  })

  it('survives a CP restart, installs the full template, and never returns credentials', async () => {
    const agentId = await placedAgent()
    await prisma.agent.update({
      where: { id: agentId },
      data: { description: 'Helps teammates solve support requests.' }
    })
    const requests: URLSearchParams[] = []
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const form = new URLSearchParams(String(init?.body))
      requests.push(form)
      if (form.get('action') === 'begin') {
        return new Response(
          JSON.stringify({
            verification_uri_complete: 'https://accounts.feishu.cn/device?user_code=SAFE-CODE',
            device_code: 'encrypted-device-code',
            expires_in: 600,
            interval: 1
          })
        )
      }
      return new Response(
        JSON.stringify({
          client_id: 'cli_oneclick',
          client_secret: 'one-click-secret',
          user_info: { tenant_brand: 'lark' }
        })
      )
    })

    // Replica A begins the flow, then disappears before the browser's first poll.
    const first = buildHttpApp(prisma, { PUBLIC_CP_URL: 'https://cp.example.test' }, undefined, undefined, {
      feishuAppRegistration: service(fetcher)
    })
    const started = await first.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/feishu/app`,
      // The provider-reported tenant brand must win over this UI fallback.
      payload: { agentId, name: 'AgentConnect Lark', region: 'feishu' }
    })
    expect(started.statusCode).toBe(201)
    const startDto = started.json() as { id: string; authorizationUrl: string }
    expect(JSON.stringify(startDto)).not.toContain('one-click-secret')
    expect(JSON.stringify(startDto)).not.toContain('cli_oneclick')

    const authorizationUrl = new URL(startDto.authorizationUrl)
    expect(authorizationUrl.searchParams.get('createOnly')).toBe('true')
    expect(authorizationUrl.searchParams.get('name')).toBe('AgentConnect Lark')
    expect(authorizationUrl.searchParams.get('desc')).toBe(PLATFORM_APP_DESCRIPTION)
    const avatarUrl = new URL(authorizationUrl.searchParams.get('avatar')!)
    expect(avatarUrl.origin).toBe('https://cp.example.test')
    expect(avatarUrl.pathname).toBe(`/v1/agents/${agentId}/icon`)
    expect(avatarUrl.searchParams.has('v')).toBe(true)
    const avatar = await first.app.inject({
      method: 'GET',
      url: `${avatarUrl.pathname}${avatarUrl.search}`,
      headers: { origin: 'https://open.larksuite.com' }
    })
    expect(avatar.statusCode).toBe(200)
    expect(avatar.headers['content-type']).toMatch(/^image\/png/)
    expect(avatar.headers['access-control-allow-origin']).toBe('*')
    const addons = decodeAddons(authorizationUrl.searchParams.get('addons')!)
    expect(addons).toMatchObject({
      preset: true,
      scopes: { tenant: [...AGENTCONNECT_FEISHU_SCOPES] },
      events: { items: { tenant: [...AGENTCONNECT_FEISHU_EVENTS] } },
      callbacks: { items: [...AGENTCONNECT_FEISHU_CALLBACKS] }
    })
    expect(addons).toMatchObject({
      scopes: {
        tenant: expect.arrayContaining([
          'application:application:patch',
          'im:chat.members:read',
          'tenant:tenant:readonly'
        ])
      }
    })
    await first.close()

    // Replica B reconstructs the coordinator from the shared row and completes.
    const spy = new SpyControl()
    const second = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender, {
      feishuAppRegistration: service(fetcher),
      verifyFeishuBot: async () => ({ status: 'ok', name: 'One-click Bot', openId: 'ou_oneclick_bot' })
    })
    running = second

    await vi.waitFor(async () => {
      const polled = await second.app.inject({
        method: 'GET',
        url: `${ORG}/integrations/feishu/app/${startDto.id}`
      })
      expect(polled.statusCode).toBe(200)
      expect(polled.json()).toMatchObject({ status: 'completed', failureReason: null })
      expect(JSON.stringify(polled.json())).not.toContain('one-click-secret')
      expect(JSON.stringify(polled.json())).not.toContain('cli_oneclick')
    })

    // The first successful Feishu-domain response identifies a Lark tenant;
    // the durable cursor switches domains, then a later browser poll resumes it.
    expect(requests.map((request) => request.get('action'))).toEqual(['begin', 'poll', 'poll'])
    expect(requests[0]?.get('request_user_info')).toBe('open_id')
    const bot = await prisma.bot.findFirst({ where: { feishuAppId: 'cli_oneclick' } })
    expect(bot).toMatchObject({ name: 'AgentConnect Lark', feishuRegion: 'lark' })
    expect(await prisma.botSecret.findUnique({ where: { botId: bot!.id } })).toMatchObject({
      botToken: 'one-click-secret',
      appToken: 'cli_oneclick'
    })
    expect(await prisma.feishuAppRegistration.findUnique({ where: { id: startDto.id } })).toMatchObject({
      status: 'completed',
      deviceCode: null,
      appSecret: null,
      targetKey: null
    })
    expect(spy.upserts).toHaveLength(1)
    expect(spy.upserts[0]).toMatchObject({
      daemonId: DAEMON,
      spec: {
        agentId,
        platform: 'feishu',
        // §6.4 emission flip: credentials ride the opaque config envelope.
        config: { appId: 'cli_oneclick', appSecret: 'one-click-secret', region: 'lark' }
      }
    })
  }, 15_000)

  it('persists a denied authorization as a terminal status without creating a bot', async () => {
    const agentId = await placedAgent()
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const form = new URLSearchParams(String(init?.body))
      if (form.get('action') === 'begin') {
        return new Response(
          JSON.stringify({
            verification_uri_complete: 'https://accounts.feishu.cn/device?user_code=DENIED',
            device_code: 'denied-device-code',
            expires_in: 600,
            interval: 1
          })
        )
      }
      return new Response(JSON.stringify({ error: 'access_denied', error_description: 'denied' }), { status: 400 })
    })
    const app = buildHttpApp(prisma, undefined, undefined, undefined, {
      feishuAppRegistration: service(fetcher)
    })
    running = app

    const started = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/feishu/app`,
      payload: { agentId }
    })
    expect(started.statusCode).toBe(201)
    const { id } = started.json() as { id: string }

    const polled = await app.app.inject({ method: 'GET', url: `${ORG}/integrations/feishu/app/${id}` })
    expect(polled.json()).toMatchObject({ status: 'failed', failureReason: 'denied', integrationId: null })
    expect(await prisma.bot.count()).toBe(0)
    expect(await prisma.integration.count()).toBe(0)
  })

  it('rejects a new App authorized outside the organization used to sign in', async () => {
    const agentId = await placedAgent()
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const form = new URLSearchParams(String(init?.body))
      if (form.get('action') === 'begin') {
        return new Response(
          JSON.stringify({
            verification_uri_complete: 'https://accounts.feishu.cn/device?user_code=ORG-CHECK',
            device_code: 'org-check-device-code',
            expires_in: 600,
            interval: 1
          })
        )
      }
      return new Response(
        JSON.stringify({
          client_id: 'cli_other_org',
          client_secret: 'other-org-secret',
          user_info: { tenant_brand: 'feishu' }
        })
      )
    })
    const app = buildHttpApp(prisma, undefined, undefined, undefined, {
      feishuAppRegistration: service(fetcher),
      resolveFeishuAppTenant: async () => ({ status: 'ok', tenantKey: 'tenant_other_org' })
    })
    running = app

    const started = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/feishu/app`,
      payload: { agentId, region: 'feishu' }
    })
    expect(started.statusCode).toBe(201)
    const { id } = started.json() as { id: string }

    const polled = await app.app.inject({ method: 'GET', url: `${ORG}/integrations/feishu/app/${id}` })
    expect(polled.json()).toMatchObject({ status: 'failed', failureReason: 'org_mismatch' })
    expect(await prisma.bot.count()).toBe(0)
    expect(await prisma.integration.count()).toBe(0)
  })

  it('does not reuse one user’s pending setup for a different requester', async () => {
    const begin = vi.fn(async () => ({
      authorizationUrl: 'https://accounts.feishu.cn/device?user_code=ONE',
      deviceCode: 'one-device-code',
      providerDomain: 'accounts.feishu.cn',
      intervalMs: 1000,
      expiresInMs: 600_000
    }))
    const provider: FeishuRegistrationProvider = {
      begin,
      poll: async () => ({ outcome: 'pending' })
    }
    const coordinator = new FeishuAppRegistrationService(
      new PgFeishuAppRegistrationStore(prisma, new PlaintextSecretCipher()),
      provider
    )
    const common = {
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId: AgentId(randomUUID()),
      fallbackRegion: 'lark' as const,
      transport: 'socket' as const,
      appName: 'AgentConnect'
    }

    await coordinator.start({ ...common, createdByUserId: 'user-a' })
    await expect(coordinator.start({ ...common, createdByUserId: 'user-b' })).rejects.toBeInstanceOf(
      FeishuRegistrationConflictError
    )
    expect(begin).toHaveBeenCalledWith('AgentConnect', 'lark', {})
  })

  it('does not expire an authorization while its claimed provider poll is completing', async () => {
    let now = 0
    const providerResult = deferred<PollFeishuRegistration>()
    const poll = vi.fn(() => providerResult.promise)
    const coordinator = new FeishuAppRegistrationService(
      new PgFeishuAppRegistrationStore(prisma, new PlaintextSecretCipher()),
      {
        begin: async () => ({
          authorizationUrl: 'https://accounts.feishu.cn/device?user_code=LEASED',
          deviceCode: 'leased-device-code',
          providerDomain: 'accounts.feishu.cn',
          intervalMs: 1000,
          expiresInMs: 1000
        }),
        poll
      },
      () => now
    )
    const started = await coordinator.start({
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId: AgentId(randomUUID()),
      fallbackRegion: 'feishu',
      transport: 'socket',
      appName: 'AgentConnect',
      createdByUserId: 'user-a'
    })
    const finalize = vi.fn(async () => {})
    const completing = coordinator.get(started.id, OrgId(DEFAULT_ORG_ID), finalize)
    await vi.waitFor(() => expect(poll).toHaveBeenCalledOnce())

    now = 2000
    await expect(coordinator.get(started.id, OrgId(DEFAULT_ORG_ID), finalize)).resolves.toMatchObject({
      status: 'pending'
    })
    providerResult.resolve({
      outcome: 'authorized',
      appId: 'cli_lease',
      appSecret: 'lease-secret',
      region: 'feishu'
    })
    await expect(completing).resolves.toMatchObject({ status: 'completed' })
    expect(finalize).toHaveBeenCalledOnce()
  })

  it('retries across an active move, then rejects a destination without Feishu capability', async () => {
    const agentId = await placedAgent()
    await seedDaemon(prisma, UNSUPPORTED_DAEMON, {
      capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true, features: [] }
    })
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const form = new URLSearchParams(String(init?.body))
      if (form.get('action') === 'begin') {
        return new Response(
          JSON.stringify({
            verification_uri_complete: 'https://accounts.feishu.cn/device?user_code=MOVING',
            device_code: 'moving-device-code',
            expires_in: 600,
            interval: 1
          })
        )
      }
      return new Response(
        JSON.stringify({
          client_id: 'cli_moving',
          client_secret: 'moving-secret',
          user_info: { tenant_brand: 'feishu' }
        })
      )
    })
    const app = buildHttpApp(prisma, undefined, undefined, undefined, {
      feishuAppRegistration: service(fetcher)
    })
    running = app

    const started = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/feishu/app`,
      payload: { agentId }
    })
    const { id } = started.json() as { id: string }
    const releaseMove = app.deps.agentMutations.tryBeginMove(agentId)
    expect(releaseMove).not.toBeNull()

    const moving = await app.app.inject({ method: 'GET', url: `${ORG}/integrations/feishu/app/${id}` })
    expect(moving.json()).toMatchObject({ status: 'pending' })
    expect(await prisma.integration.count()).toBe(0)

    await prisma.agent.update({ where: { id: agentId }, data: { daemonId: UNSUPPORTED_DAEMON } })
    releaseMove!()
    const unsupported = await app.app.inject({ method: 'GET', url: `${ORG}/integrations/feishu/app/${id}` })
    expect(unsupported.json()).toMatchObject({ status: 'failed', failureReason: 'agent_unavailable' })
    expect(await prisma.bot.count()).toBe(0)
    expect(await prisma.integration.count()).toBe(0)
  })

  it('retries a failed daemon push without duplicating the persisted integration', async () => {
    const agentId = await placedAgent()
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const form = new URLSearchParams(String(init?.body))
      if (form.get('action') === 'begin') {
        return new Response(
          JSON.stringify({
            verification_uri_complete: 'https://accounts.feishu.cn/device?user_code=RETRY',
            device_code: 'retry-device-code',
            expires_in: 600,
            interval: 1
          })
        )
      }
      return new Response(
        JSON.stringify({
          client_id: 'cli_retry',
          client_secret: 'retry-secret',
          user_info: { tenant_brand: 'feishu' }
        })
      )
    })
    const control = new FlakyControl()
    const app = buildHttpApp(prisma, undefined, undefined, control as unknown as ControlSender, {
      feishuAppRegistration: service(fetcher)
    })
    running = app

    const started = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/feishu/app`,
      payload: { agentId }
    })
    const { id } = started.json() as { id: string }
    const first = await app.app.inject({ method: 'GET', url: `${ORG}/integrations/feishu/app/${id}` })
    expect(first.json()).toMatchObject({ status: 'pending', integrationId: null })
    const persisted = await prisma.integration.findFirstOrThrow({ where: { agentId, platform: 'feishu' } })
    expect(await prisma.integration.count()).toBe(1)
    expect(await prisma.feishuAppRegistration.findUnique({ where: { id } })).toMatchObject({
      status: 'authorized',
      integrationId: persisted.id,
      appSecret: 'retry-secret'
    })

    const retried = await app.app.inject({ method: 'GET', url: `${ORG}/integrations/feishu/app/${id}` })
    expect(retried.json()).toMatchObject({ status: 'completed', integrationId: persisted.id })
    expect(await prisma.integration.count()).toBe(1)
    expect(control.upserts).toHaveLength(2)
    expect(await prisma.feishuAppRegistration.findUnique({ where: { id } })).toMatchObject({
      status: 'completed',
      appSecret: null,
      targetKey: null
    })
  })

  it('one-click HTTP configures the relay callback before completing', async () => {
    const agentId = await placedAgent()
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const form = new URLSearchParams(String(init?.body))
      if (form.get('action') === 'begin') {
        return new Response(
          JSON.stringify({
            verification_uri_complete: 'https://accounts.larksuite.com/device?user_code=HTTP',
            device_code: 'http-device-code',
            expires_in: 600,
            interval: 1
          })
        )
      }
      return new Response(
        JSON.stringify({
          client_id: 'cli_http_oneclick',
          client_secret: 'http-one-click-secret',
          user_info: { tenant_brand: 'lark' }
        })
      )
    })
    const order: string[] = []
    const relayFrames: Array<{ type: string; payload: unknown }> = []
    const configureFeishuHttpApp = vi.fn(async () => {
      order.push('configure')
    })
    const control = new SpyControl()
    const app = buildHttpApp(
      prisma,
      { PUBLIC_RELAY_URL: 'wss://relay.example' },
      undefined,
      control as unknown as ControlSender,
      {
        feishuAppRegistration: service(fetcher),
        verifyFeishuBot: async () => ({ status: 'ok', name: 'HTTP Bot', openId: 'ou_http_bot' }),
        configureFeishuHttpApp
      }
    )
    running = app
    app.relayReg.add({
      relayId: 'r1',
      send(type, payload) {
        relayFrames.push({ type, payload })
        if (type === 'rc/bot-assign') order.push('assign')
      },
      close() {}
    } as RelayChannel)

    const started = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/feishu/app`,
      payload: { agentId, region: 'lark', transport: 'http' }
    })
    expect(started.statusCode).toBe(201)
    const startDto = started.json() as { id: string; transport: string }
    expect(startDto.transport).toBe('http')

    await vi.waitFor(
      async () => {
        const polled = await app.app.inject({
          method: 'GET',
          url: `${ORG}/integrations/feishu/app/${startDto.id}`
        })
        expect(polled.json()).toMatchObject({ status: 'completed' })
      },
      { timeout: 5_000 }
    )

    const bot = await prisma.bot.findFirstOrThrow({ where: { feishuAppId: 'cli_http_oneclick' } })
    const secret = await prisma.botSecret.findUniqueOrThrow({ where: { botId: bot.id } })
    expect(bot).toMatchObject({ transport: 'http', botUserId: 'ou_http_bot' })
    expect(secret.verificationToken).toHaveLength(32)
    expect(secret.encryptKey).toHaveLength(32)
    expect(configureFeishuHttpApp).toHaveBeenCalledWith({
      appId: 'cli_http_oneclick',
      appSecret: 'http-one-click-secret',
      region: 'lark',
      requestUrl: 'https://relay.example/feishu/events',
      verificationToken: secret.verificationToken,
      encryptKey: secret.encryptKey
    })
    expect(order.slice(0, 2)).toEqual(['assign', 'configure'])
    expect(relayFrames).toContainEqual({
      type: 'rc/bot-assign',
      payload: expect.objectContaining({
        platform: 'feishu',
        ingress: expect.objectContaining({ apiAppId: 'cli_http_oneclick' }),
        secrets: { verificationToken: secret.verificationToken, encryptKey: secret.encryptKey }
      })
    })
    expect(control.upserts[0]?.spec).toMatchObject({
      platform: 'feishu',
      core: { mode: 'shared' },
      config: { botOpenId: 'ou_http_bot' }
    })
  })

  it('rejects one-click HTTP before creating a provider session when relay delivery is unavailable', async () => {
    const agentId = await placedAgent()
    const begin = vi.fn(async () => ({
      authorizationUrl: 'https://accounts.larksuite.com/device?user_code=NEVER',
      deviceCode: 'never',
      providerDomain: 'accounts.larksuite.com',
      intervalMs: 1000,
      expiresInMs: 600_000
    }))
    const app = buildHttpApp(prisma, { PUBLIC_RELAY_URL: 'wss://relay.example' }, undefined, undefined, {
      feishuAppRegistration: new FeishuAppRegistrationService(
        new PgFeishuAppRegistrationStore(prisma, new PlaintextSecretCipher()),
        { begin, poll: async () => ({ outcome: 'pending' }) }
      )
    })
    running = app

    const response = await app.app.inject({
      method: 'POST',
      url: `${ORG}/integrations/feishu/app`,
      payload: { agentId, transport: 'http' }
    })
    expect(response.statusCode).toBe(409)
    expect(begin).not.toHaveBeenCalled()
  })
})
