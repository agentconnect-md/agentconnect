/** A per-agent Google Chat app's key rotation (§3); the deployment app takes its key from the Setup Server. */
import { generateKeyPairSync } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HttpDeps } from '../../http/deps.js'
import { installZod } from '../../http/plugins/zod.js'
import type { BotRecord } from '../../persistence/ports.js'
import { AgentId, BotId, OrgId } from '../../domain/ids.js'
import { GOOGLE_CHAT_PROBE_URL, GOOGLE_TOKEN_ENDPOINT, googleCloudProjectUrl } from './credential.js'
import { GOOGLE_CHAT_DEPLOYMENT_KEY_MESSAGE, googleChatKeyRoutes } from './routes.js'

const ORG = OrgId('11111111-1111-4111-8111-111111111111')
const PRESET = AgentId('77777777-7777-4777-8777-777777777777')
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
// The replacement key, pretty-printed so the stored form is visibly canonical.
const ROTATED = {
  type: 'service_account',
  project_id: PROJECT_ID,
  private_key: PRIVATE_KEY,
  client_email: `chat-app@${PROJECT_ID}.iam.gserviceaccount.com`
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
      repos: { bot: { get: async () => bot }, botCredential: { install } },
      platforms: { get: () => undefined }
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
