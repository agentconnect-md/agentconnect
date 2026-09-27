/** The deployment-owned Google Chat app's install route: the resolved project number and an app that already has a bot (§3). */
import { generateKeyPairSync } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HttpDeps } from '../../http/deps.js'
import { installZod } from '../../http/plugins/zod.js'
import type { BotRecord, IntegrationRecord } from '../../persistence/ports.js'
import { AgentId, BotId, IntegrationId, OrgId } from '../../domain/ids.js'
import type { GoogleChatPlatformAppConfig } from '../../config/google-chat-platform.js'
import { GOOGLE_CHAT_PROBE_URL, GOOGLE_TOKEN_ENDPOINT, googleCloudProjectUrl } from './credential.js'
import { GOOGLE_CHAT_APP_TAKEN_MESSAGE } from './provider.js'
import {
  GOOGLE_CHAT_DEPLOYMENT_KEY_MESSAGE,
  GOOGLE_CHAT_PROJECT_CHANGED_MESSAGE,
  googleChatKeyRoutes,
  googleChatPlatformInstallRoutes
} from './routes.js'

const ORG = OrgId('11111111-1111-4111-8111-111111111111')
const OTHER_ORG = OrgId('22222222-2222-4222-8222-222222222222')
const PRESET = AgentId('77777777-7777-4777-8777-777777777777')
const OTHER_AGENT = AgentId('66666666-6666-4666-8666-666666666666')
const BOT = BotId('88888888-8888-4888-8888-888888888888')
const PROJECT_ID = 'example-project'
// What Cloud Resource Manager reports for the key's project.
const PROJECT_NUMBER = '123456789012'
const CRM_URL = googleCloudProjectUrl(PROJECT_ID)
const { privateKey: PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
})
// The rotated key the Setup Server stored, pretty-printed so the re-stamp is visibly canonical.
const ROTATED = {
  type: 'service_account',
  project_id: PROJECT_ID,
  private_key: PRIVATE_KEY,
  client_email: `chat-app@${PROJECT_ID}.iam.gserviceaccount.com`
}
const DEPLOYMENT_APP: GoogleChatPlatformAppConfig = {
  projectId: PROJECT_ID,
  projectNumber: PROJECT_NUMBER,
  serviceAccountKey: JSON.stringify(ROTATED, null, 2),
  multiTenant: false
}

const HELD: IntegrationRecord = {
  id: IntegrationId('99999999-9999-4999-8999-999999999999'),
  orgId: ORG,
  agentId: PRESET,
  botId: BOT,
  platform: 'googlechat',
  name: `Google Chat · ${PROJECT_ID}`,
  status: 'active',
  createdAt: new Date('2026-09-27T00:00:00Z')
}

function existingBot(over: Partial<BotRecord> = {}): BotRecord {
  return {
    id: BOT,
    orgId: ORG,
    platformConfig: { projectId: PROJECT_ID },
    externalAppId: PROJECT_NUMBER,
    externalTenantId: '-',
    ...over
  } as BotRecord
}

let running: FastifyInstance | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

async function harness(
  bot: BotRecord | null,
  opts: { google?: 'ok' | 'rejected'; app?: GoogleChatPlatformAppConfig; rows?: BotRecord[]; spaces?: unknown[] } = {}
) {
  const googleCalls: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    googleCalls.push(url)
    if (url === GOOGLE_TOKEN_ENDPOINT) {
      return opts.google === 'rejected'
        ? Response.json({ error: 'invalid_grant' }, { status: 400 })
        : Response.json({ access_token: 'synthetic-access-token' })
    }
    if (url === CRM_URL) return Response.json({ projectNumber: PROJECT_NUMBER, projectId: PROJECT_ID })
    if (url === GOOGLE_CHAT_PROBE_URL) return Response.json({ spaces: opts.spaces ?? [] })
    throw new Error(`unexpected request to ${url}`)
  }) as typeof fetch
  const install = vi.fn(async (_org: OrgId, _id: BotId, _secrets: unknown, _at: Date) => 2)
  const syncBot = vi.fn(async (_id: BotId) => {})
  const listForBot = vi.fn(async () => (bot?.id === BOT ? [HELD] : []))
  const getByExternalIdentity = vi.fn(async () => bot)
  // The merge, applied to the held row as the repository would under its lock.
  const merges: Record<string, unknown>[] = []
  const mergeBotIdentity = vi.fn(
    async (
      _org: OrgId,
      _id: BotId,
      merge: (current: { platformConfig: Record<string, unknown>; externalTenantId: string | null }) => {
        platformConfig?: Record<string, string>
      }
    ) => {
      const change = merge({
        platformConfig: bot?.platformConfig ?? {},
        externalTenantId: bot?.externalTenantId ?? null
      })
      merges.push(change)
      return Object.keys(change.platformConfig ?? {}).length > 0
    }
  )
  const deps = {
    config: { PUBLIC_RELAY_URL: 'https://relay.example.test' },
    httpBot: { hasConnectedRelay: () => true, syncBot },
    placementResolver: { servingDaemon: async () => null },
    repos: {
      presetAgent: { get: async () => ({ agentId: PRESET }) },
      agent: {
        get: async (_org: OrgId, id: AgentId) => ({ id, orgId: ORG, name: 'agentconnect', visibility: 'org' })
      },
      bot: { getByExternalIdentity, listForPlatform: async () => opts.rows ?? [], mergeBotIdentity },
      integration: { listForBot },
      integrationChannel: { listForIntegration: async () => [] },
      botCredential: { install }
    }
  } as unknown as HttpDeps
  const app = Fastify()
  installZod(app)
  app.addHook('onRequest', async (req) => {
    req.principal = { userId: 'user-1' }
    req.orgCtx = { orgId: ORG, role: 'collaborator', userId: 'user-1' } as never
  })
  await app.register(googleChatPlatformInstallRoutes(deps, { app: opts.app ?? DEPLOYMENT_APP, fetch: fetchImpl }))
  running = app
  const post = (payload: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/integrations/googlechat/platform-install', payload })
  return { post, googleCalls, install, syncBot, listForBot, getByExternalIdentity, mergeBotIdentity, merges }
}

describe('POST /integrations/googlechat/platform-install: the resolved project number', () => {
  it('looks the app up by the number resolved from the key’s project', async () => {
    const h = await harness(existingBot())

    expect((await h.post()).statusCode).toBe(200)
    expect(h.googleCalls).toEqual([GOOGLE_TOKEN_ENDPOINT, CRM_URL, GOOGLE_TOKEN_ENDPOINT, GOOGLE_CHAT_PROBE_URL])
    expect(h.getByExternalIdentity).toHaveBeenCalledWith('googlechat', PROJECT_NUMBER, '-')
  })

  it('refuses a configured number that is not the key’s project, before any lookup or write', async () => {
    const h = await harness(existingBot(), { app: { ...DEPLOYMENT_APP, projectNumber: '210987654321' } })

    const res = await h.post()
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({
      code: 'GOOGLE_CHAT_PROJECT_NUMBER_MISMATCH',
      message: `the project number 210987654321 does not match project ${PROJECT_ID}, whose number is ${PROJECT_NUMBER}`
    })
    expect(h.getByExternalIdentity).not.toHaveBeenCalled()
    expect(h.install).not.toHaveBeenCalled()
  })
})

describe('POST /integrations/googlechat/platform-install for an app that already has a bot', () => {
  it('re-stamps the holding agent’s bot with the current deployment key and answers 200 with its integration', async () => {
    const h = await harness(existingBot())

    const res = await h.post()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: HELD.id, botId: BOT, agentId: PRESET, platform: 'googlechat' })
    expect(res.body).not.toContain('PRIVATE KEY')
    expect(h.install).toHaveBeenCalledWith(
      ORG,
      BOT,
      { botToken: JSON.stringify(ROTATED), appToken: null, signingSecret: null },
      expect.any(Date)
    )
    expect(h.syncBot).toHaveBeenCalledWith(BOT)
  })

  it('re-stamps every claimed customer row of the app with the rotated key and re-syncs each (§10.3)', async () => {
    const anchor = existingBot()
    const customerA = existingBot({
      id: BotId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      orgId: OTHER_ORG,
      externalTenantId: 'customers/C0000000001',
      platformConfig: { projectId: PROJECT_ID, customerId: 'C0000000001' }
    })
    const customerB = existingBot({
      id: BotId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
      orgId: OrgId('33333333-3333-4333-8333-333333333333'),
      externalTenantId: 'domains/0000000002',
      platformConfig: { projectId: PROJECT_ID, domainIds: '0000000002' }
    })
    const otherApp = existingBot({
      id: BotId('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
      externalAppId: '210987654321',
      externalTenantId: 'customers/C0000000009'
    })
    const h = await harness(anchor, {
      app: { ...DEPLOYMENT_APP, multiTenant: true },
      rows: [anchor, customerA, customerB, otherApp]
    })

    expect((await h.post()).statusCode).toBe(200)
    const secrets = { botToken: JSON.stringify(ROTATED), appToken: null, signingSecret: null }
    expect(h.install.mock.calls.map(([org, id]) => [org, id])).toEqual([
      [ORG, BOT],
      [OTHER_ORG, customerA.id],
      [customerB.orgId, customerB.id]
    ])
    for (const call of h.install.mock.calls) expect(call[2]).toEqual(secrets)
    expect(h.syncBot.mock.calls.map(([id]) => id)).toEqual([BOT, customerA.id, customerB.id])
    // The anchor never learns a customer: with the switch on it serves none.
    expect(h.mergeBotIdentity).not.toHaveBeenCalled()
  })

  it('stamps the one customer the probe proves on a single-tenant deployment row when it has none (§10.3)', async () => {
    const spaces = [{ name: 'spaces/A', spaceType: 'SPACE', customer: 'customers/C0000000001' }]
    const h = await harness(existingBot(), { spaces })
    expect((await h.post()).statusCode).toBe(200)
    expect(h.merges).toEqual([{ platformConfig: { customerId: 'C0000000001' } }])
    expect(h.syncBot).toHaveBeenCalledWith(BOT)

    // A row that already knows its customer is left alone, and the switch on never stamps the anchor.
    const known = await harness(existingBot({ platformConfig: { projectId: PROJECT_ID, customerId: 'C0000000001' } }), {
      spaces
    })
    expect((await known.post()).statusCode).toBe(200)
    expect(known.merges).toEqual([{}])
    const anchored = await harness(existingBot(), { spaces, app: { ...DEPLOYMENT_APP, multiTenant: true } })
    expect((await anchored.post()).statusCode).toBe(200)
    expect(anchored.mergeBotIdentity).not.toHaveBeenCalled()
  })

  it('writes nothing when the current key no longer validates', async () => {
    const h = await harness(existingBot(), { google: 'rejected' })

    const res = await h.post({ agentId: PRESET })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('GOOGLE_CHAT_KEY_REJECTED')
    expect(h.install).not.toHaveBeenCalled()
    expect(h.syncBot).not.toHaveBeenCalled()
  })

  it('keeps the 409 when another agent holds the app', async () => {
    const h = await harness(existingBot())

    const res = await h.post({ agentId: OTHER_AGENT })
    expect(res.statusCode).toBe(409)
    expect(res.json().message).toBe(GOOGLE_CHAT_APP_TAKEN_MESSAGE)
    expect(h.install).not.toHaveBeenCalled()
    expect(h.syncBot).not.toHaveBeenCalled()
  })

  it('keeps the 409 when another organization holds the app, without reading its installs', async () => {
    const h = await harness(existingBot({ orgId: OTHER_ORG }))

    const res = await h.post()
    expect(res.statusCode).toBe(409)
    expect(res.json().message).toBe(GOOGLE_CHAT_APP_TAKEN_MESSAGE)
    expect(h.listForBot).not.toHaveBeenCalled()
    expect(h.install).not.toHaveBeenCalled()
  })

  it('refuses to move the bot to a different project ID under the same project number', async () => {
    const h = await harness(existingBot({ platformConfig: { projectId: 'other-example-project' } }))

    const res = await h.post()
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({
      code: 'GOOGLE_CHAT_PROJECT_CHANGED',
      message: GOOGLE_CHAT_PROJECT_CHANGED_MESSAGE
    })
    expect(h.install).not.toHaveBeenCalled()
  })
})

describe('GET /integrations/googlechat/platform-install', () => {
  async function availability(app: GoogleChatPlatformAppConfig | undefined, relayConnected: boolean) {
    const deps = {
      config: { PUBLIC_RELAY_URL: 'https://relay.example.test' },
      httpBot: { hasConnectedRelay: () => relayConnected }
    } as unknown as HttpDeps
    const server = Fastify()
    installZod(server)
    server.addHook('onRequest', async (req) => {
      req.principal = { userId: 'user-1' }
      req.orgCtx = { orgId: ORG, role: 'viewer', userId: 'user-1' } as never
    })
    await server.register(
      googleChatPlatformInstallRoutes(deps, {
        ...(app ? { app } : {}),
        fetch: (async () => {
          throw new Error('availability never calls Google')
        }) as typeof fetch
      })
    )
    running = server
    const res = await server.inject({ method: 'GET', url: '/integrations/googlechat/platform-install' })
    await server.close()
    running = undefined
    return res
  }

  it('offers the deployment app only when it is configured and a relay is connected', async () => {
    expect((await availability(DEPLOYMENT_APP, true)).json()).toEqual({ available: true })
    expect((await availability(DEPLOYMENT_APP, false)).json()).toEqual({ available: false })
    const unconfigured = await availability(undefined, true)
    expect(unconfigured.statusCode).toBe(200)
    expect(unconfigured.json()).toEqual({ available: false })
  })

  it('never returns the key or the project', async () => {
    const res = await availability(DEPLOYMENT_APP, true)
    expect(res.body).not.toContain(PROJECT_ID)
    expect(res.body).not.toContain('PRIVATE KEY')
  })
})

describe('PUT /bots/:id/googlechat/key', () => {
  async function keyHarness(bot: BotRecord | null, opts: { crmNumber?: string } = {}) {
    const googleCalls: string[] = []
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      googleCalls.push(url)
      if (url === GOOGLE_TOKEN_ENDPOINT) return Response.json({ access_token: 'synthetic-access-token' })
      if (url === CRM_URL)
        return Response.json({ projectNumber: opts.crmNumber ?? PROJECT_NUMBER, projectId: PROJECT_ID })
      if (url === GOOGLE_CHAT_PROBE_URL) return Response.json({ spaces: [] })
      throw new Error(`unexpected request to ${url}`)
    }) as typeof fetch
    const install = vi.fn(async () => 3)
    const syncBot = vi.fn(async () => {})
    const deps = {
      clock: { now: () => Date.parse('2026-09-27T00:00:00Z') },
      httpBot: { syncBot },
      repos: { bot: { get: async () => bot }, botCredential: { install } }
    } as unknown as HttpDeps
    const app = Fastify()
    installZod(app)
    app.addHook('onRequest', async (req) => {
      req.principal = { userId: 'user-1' }
      req.orgCtx = { orgId: ORG, role: 'collaborator', userId: 'user-1' } as never
    })
    await app.register(googleChatKeyRoutes(deps, { fetch: fetchImpl }))
    running = app
    const put = (serviceAccountKey: string) =>
      app.inject({ method: 'PUT', url: `/bots/${BOT}/googlechat/key`, payload: { serviceAccountKey } })
    return { put, googleCalls, install, syncBot }
  }

  // A whole row, because the 200 serializes it as a `BotDto`.
  const perAgentBot = (over: Partial<BotRecord> = {}) =>
    existingBot({
      platform: 'googlechat',
      name: `Google Chat · ${PROJECT_ID}`,
      prebuilt: false,
      slackAppId: null,
      teamId: null,
      workspaceId: null,
      workspaceName: null,
      discordAppId: null,
      feishuAppId: null,
      feishuRegion: null,
      shareable: false,
      transport: 'http',
      createdBy: null,
      lastUsedAt: null,
      lastAgentName: null,
      agentIds: [PRESET],
      inUseByAgentId: PRESET,
      revokedAt: null,
      revokedReason: null,
      revokedEvidence: null,
      revokedCode: null,
      credentialRejectedAt: null,
      credentialRejectedCode: null,
      createdAt: new Date('2026-09-27T00:00:00Z'),
      ...over
    } as Partial<BotRecord>)

  it('stores a key that validates for the same project and pushes it to the serving daemons', async () => {
    const h = await keyHarness(perAgentBot())

    const res = await h.put(JSON.stringify(ROTATED, null, 2))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      id: BOT,
      externalAppId: PROJECT_NUMBER,
      platformConfig: { projectId: PROJECT_ID }
    })
    expect(res.body).not.toContain('PRIVATE KEY')
    expect(h.install).toHaveBeenCalledWith(
      ORG,
      BOT,
      { botToken: JSON.stringify(ROTATED), appToken: null, signingSecret: null },
      expect.any(Date)
    )
    expect(h.syncBot).toHaveBeenCalledWith(BOT)
  })

  it('refuses a key whose project resolves to another number, before any write', async () => {
    const h = await keyHarness(perAgentBot(), { crmNumber: '210987654321' })

    const res = await h.put(JSON.stringify(ROTATED))
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('GOOGLE_CHAT_PROJECT_NUMBER_MISMATCH')
    expect(h.install).not.toHaveBeenCalled()
    expect(h.syncBot).not.toHaveBeenCalled()
  })

  it('refuses a key from another project', async () => {
    const h = await keyHarness(perAgentBot({ platformConfig: { projectId: 'other-example-project' } }))

    const res = await h.put(JSON.stringify(ROTATED))
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('GOOGLE_CHAT_PROJECT_MISMATCH')
    expect(h.googleCalls).toEqual([])
    expect(h.install).not.toHaveBeenCalled()
  })

  it('leaves the deployment app’s key to the Setup Server', async () => {
    const h = await keyHarness(perAgentBot({ prebuilt: true }))

    const res = await h.put(JSON.stringify(ROTATED))
    expect(res.statusCode).toBe(409)
    expect(res.json().message).toBe(GOOGLE_CHAT_DEPLOYMENT_KEY_MESSAGE)
    expect(h.install).not.toHaveBeenCalled()
  })

  it('answers 404 for a bot of another platform', async () => {
    const h = await keyHarness(perAgentBot({ platform: 'slack' } as Partial<BotRecord>))

    expect((await h.put(JSON.stringify(ROTATED))).statusCode).toBe(404)
    expect(h.install).not.toHaveBeenCalled()
  })
})
