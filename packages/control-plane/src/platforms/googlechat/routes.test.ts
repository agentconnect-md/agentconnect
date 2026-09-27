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
import { GOOGLE_CHAT_PROJECT_CHANGED_MESSAGE, googleChatPlatformInstallRoutes } from './routes.js'

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
  client_email: 'chat@example.test'
}
const DEPLOYMENT_APP: GoogleChatPlatformAppConfig = {
  projectId: PROJECT_ID,
  projectNumber: PROJECT_NUMBER,
  serviceAccountKey: JSON.stringify(ROTATED, null, 2)
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
  opts: { google?: 'ok' | 'rejected'; app?: GoogleChatPlatformAppConfig } = {}
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
    if (url === GOOGLE_CHAT_PROBE_URL) return Response.json({ spaces: [] })
    throw new Error(`unexpected request to ${url}`)
  }) as typeof fetch
  const install = vi.fn(async () => 2)
  const syncBot = vi.fn(async () => {})
  const listForBot = vi.fn(async () => (bot?.id === BOT ? [HELD] : []))
  const getByExternalIdentity = vi.fn(async () => bot)
  const deps = {
    config: { PUBLIC_RELAY_URL: 'https://relay.example.test' },
    httpBot: { hasConnectedRelay: () => true, syncBot },
    placementResolver: { servingDaemon: async () => null },
    repos: {
      presetAgent: { get: async () => ({ agentId: PRESET }) },
      agent: {
        get: async (_org: OrgId, id: AgentId) => ({ id, orgId: ORG, name: 'agentconnect', visibility: 'org' })
      },
      bot: { getByExternalIdentity },
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
  return { post, googleCalls, install, syncBot, listForBot, getByExternalIdentity }
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
