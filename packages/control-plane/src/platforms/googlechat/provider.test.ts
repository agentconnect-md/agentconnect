/** Google Chat CpPlatformProvider (google-chat-integration.md §3, §7) — unit, against a fake Google HTTP layer. */
import { generateKeyPairSync } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import type { FastifyPluginAsync } from 'fastify'
import { IntegrationGoogleChatConfig, manifestFor, type IntegrationCoreEnvelope } from '@agentconnect.md/protocol'
import {
  createGoogleChatCpProvider,
  GOOGLE_CHAT_APP_TAKEN_MESSAGE,
  GoogleChatCpEnvSchema,
  googleChatBotAssignBags
} from './provider.js'
import { GOOGLE_CHAT_PROBE_URL, GOOGLE_TOKEN_ENDPOINT } from './credential.js'
import { buildCpPlatformRegistry } from '../registry.js'
import { buildCreateIntegrationBody } from '../../http/dto/create-integration-body.js'
import type { BotRecord, CreateBotInput, IntegrationRecord } from '../../persistence/ports.js'
import { AgentId, BotId, IntegrationId, OrgId } from '../../domain/ids.js'

const ORG = OrgId('11111111-1111-4111-8111-111111111111')
const AGENT_ID = AgentId('77777777-7777-4777-8777-777777777777')
const PROJECT_ID = 'example-project'
const PROJECT_NUMBER = '123456789012'
const { privateKey: PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
})
const KEY_FIELDS = {
  type: 'service_account',
  project_id: PROJECT_ID,
  private_key_id: 'synthetic-key-id',
  private_key: PRIVATE_KEY,
  client_email: `agentconnect-chat@${PROJECT_ID}.iam.gserviceaccount.com`
}
// Pretty-printed as the downloaded file is, so the stored form is visibly canonicalized.
const KEY = JSON.stringify(KEY_FIELDS, null, 2)
const CREDENTIALS = { projectId: PROJECT_ID, projectNumber: PROJECT_NUMBER, serviceAccountKey: KEY }
const CORE: IntegrationCoreEnvelope = {
  mode: 'shared',
  bindRules: [],
  mutedChannels: [],
  gated: false,
  sessionModes: [],
  decisions: { bindings: [], definitions: [] }
}

type GoogleAnswer = 'ok' | 'rejected' | 'offline' | 'no_app'

/** Answers only Google's fixed token endpoint and the one Chat API read, recording every call. */
function fakeGoogle(answer: GoogleAnswer = 'ok') {
  const calls: { method: string; url: string }[] = []
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ method: init.method ?? 'GET', url })
    if (answer === 'offline') throw new TypeError('fetch failed')
    if (url === GOOGLE_TOKEN_ENDPOINT) {
      return answer === 'rejected'
        ? Response.json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, { status: 400 })
        : Response.json({ access_token: 'synthetic-access-token', token_type: 'Bearer', expires_in: 3599 })
    }
    if (url === GOOGLE_CHAT_PROBE_URL) {
      return answer === 'no_app'
        ? Response.json({ error: { code: 404, message: 'Google Chat app not found.' } }, { status: 404 })
        : Response.json({ spaces: [] })
    }
    throw new Error(`unexpected request to ${url}`)
  }) as typeof fetch
  return { fetchImpl, calls }
}

function bot(over: Partial<BotRecord> = {}): BotRecord {
  return {
    id: BotId('88888888-8888-4888-8888-888888888888'),
    orgId: ORG,
    platform: 'googlechat',
    name: `Google Chat · ${PROJECT_ID}`,
    prebuilt: false,
    slackAppId: null,
    teamId: null,
    workspaceId: null,
    workspaceName: null,
    botUserId: null,
    revokedAt: null,
    revokedReason: null,
    revokedEvidence: null,
    revokedCode: null,
    credentialRejectedAt: null,
    credentialRejectedCode: null,
    credentialRevision: 1,
    credentialInstalledAt: null,
    grantedScopes: null,
    externalAppId: PROJECT_NUMBER,
    externalTenantId: '-',
    platformConfig: { projectId: PROJECT_ID },
    discordAppId: null,
    feishuAppId: null,
    feishuRegion: null,
    shareable: false,
    transport: 'http',
    createdBy: null,
    lastUsedAt: null,
    lastAgentName: null,
    agentIds: [AGENT_ID],
    inUseByAgentId: AGENT_ID,
    createdAt: new Date('2026-09-27T00:00:00Z'),
    ...over
  }
}

function integration(): IntegrationRecord {
  return {
    id: IntegrationId('99999999-9999-4999-8999-999999999999'),
    orgId: ORG,
    agentId: AGENT_ID,
    botId: bot().id,
    platform: 'googlechat',
    name: bot().name,
    status: 'active',
    createdAt: new Date('2026-09-27T00:00:00Z')
  }
}

describe('the googlechat create body', () => {
  const body = buildCreateIntegrationBody(buildCpPlatformRegistry([createGoogleChatCpProvider()]))
  const create = (transport?: 'http' | 'socket') => ({
    platform: 'googlechat',
    agentId: AGENT_ID,
    ...(transport ? { transport } : {}),
    googlechat: CREDENTIALS
  })

  it('accepts a project, its number, and the key on the http transport', () => {
    expect(body.safeParse(create('http')).success).toBe(true)
  })

  it('refuses the socket transport, including the omitted default', () => {
    for (const transport of ['socket', undefined] as const) {
      const parsed = body.safeParse(create(transport))
      expect(parsed.success).toBe(false)
      expect(parsed.error?.issues.map((issue) => issue.message)).toContain(
        'googlechat requires transport http: Google Chat events arrive through the relay'
      )
    }
  })
})

describe('validateConfig', () => {
  it('runs the key check, then one token exchange and one Chat API read, and sends nothing', async () => {
    const google = fakeGoogle()
    const result = await createGoogleChatCpProvider({ fetch: google.fetchImpl }).validateConfig(CREDENTIALS, 'http')

    expect(result).toEqual({
      ok: true,
      identity: { name: `Google Chat · ${PROJECT_ID}`, externalAppId: PROJECT_NUMBER }
    })
    expect(google.calls).toEqual([
      { method: 'POST', url: GOOGLE_TOKEN_ENDPOINT },
      { method: 'GET', url: GOOGLE_CHAT_PROBE_URL }
    ])
  })

  it('refuses a non-numeric project number before calling Google', async () => {
    const google = fakeGoogle()
    const result = await createGoogleChatCpProvider({ fetch: google.fetchImpl }).validateConfig(
      { ...CREDENTIALS, projectNumber: PROJECT_ID },
      'http'
    )
    expect(result).toMatchObject({ ok: false, status: 400, code: 'GOOGLE_CHAT_PROJECT_NUMBER_INVALID' })
    expect(google.calls).toEqual([])
  })

  it('refuses a key of another project, or another credential shape, before calling Google', async () => {
    const google = fakeGoogle()
    const provider = createGoogleChatCpProvider({ fetch: google.fetchImpl })
    expect(await provider.validateConfig({ ...CREDENTIALS, projectId: 'other-example-project' }, 'http')).toMatchObject(
      { ok: false, status: 400, code: 'GOOGLE_CHAT_PROJECT_MISMATCH' }
    )
    expect(
      await provider.validateConfig(
        { ...CREDENTIALS, serviceAccountKey: JSON.stringify({ ...KEY_FIELDS, type: 'authorized_user' }) },
        'http'
      )
    ).toMatchObject({ ok: false, status: 400, code: 'GOOGLE_CHAT_KEY_INVALID' })
    expect(google.calls).toEqual([])
  })

  it('answers a rejected key as an authentication failure, and a missing Chat app as the project’s', async () => {
    const rejected = await createGoogleChatCpProvider({ fetch: fakeGoogle('rejected').fetchImpl }).validateConfig(
      CREDENTIALS,
      'http'
    )
    expect(rejected).toMatchObject({
      ok: false,
      status: 400,
      code: 'GOOGLE_CHAT_KEY_REJECTED',
      message: expect.stringMatching(/^Authentication failed/)
    })
    const noApp = await createGoogleChatCpProvider({ fetch: fakeGoogle('no_app').fetchImpl }).validateConfig(
      CREDENTIALS,
      'http'
    )
    expect(noApp).toMatchObject({ ok: false, status: 400, code: 'GOOGLE_CHAT_APP_UNAVAILABLE' })
  })

  it('answers an unreachable Google as a 503 connectivity failure, never as a bad key', async () => {
    const result = await createGoogleChatCpProvider({ fetch: fakeGoogle('offline').fetchImpl }).validateConfig(
      CREDENTIALS,
      'http'
    )
    expect(result).toMatchObject({
      ok: false,
      status: 503,
      code: 'GOOGLE_CHAT_UNREACHABLE',
      message: expect.stringMatching(/^Connection failed/)
    })
  })

  it('never echoes the key in a refusal', async () => {
    for (const answer of ['rejected', 'offline', 'no_app'] as const) {
      const result = await createGoogleChatCpProvider({ fetch: fakeGoogle(answer).fetchImpl }).validateConfig(
        CREDENTIALS,
        'http'
      )
      expect(JSON.stringify(result)).not.toContain('PRIVATE KEY')
    }
  })
})

describe('the rows one Chat app writes', () => {
  const provider = createGoogleChatCpProvider()
  const identity = { name: `Google Chat · ${PROJECT_ID}`, externalAppId: PROJECT_NUMBER }

  it('carries the project number as the app identity and the project ID as public metadata', () => {
    const install = provider.buildNewBotInstall({
      credentials: CREDENTIALS,
      identity,
      transport: 'http',
      shareable: true
    })
    expect(install.bot).toEqual({ externalAppId: PROJECT_NUMBER, platformConfig: { projectId: PROJECT_ID } })
    expect(install.externalIdentity).toEqual({
      externalAppId: PROJECT_NUMBER,
      externalTenantId: '-',
      conflictMessage: GOOGLE_CHAT_APP_TAKEN_MESSAGE
    })
    expect(manifestFor('googlechat').multiAgentShareable).toBe(false)
  })

  it('stores the key write-only as canonical JSON in the bot secret row', () => {
    const { secrets } = provider.buildNewBotInstall({
      credentials: CREDENTIALS,
      identity,
      transport: 'http',
      shareable: false
    })
    expect(secrets).toEqual({ botToken: JSON.stringify(KEY_FIELDS), appToken: null, signingSecret: null })
    expect(Object.keys(provider.secretShape.slots)).toEqual(['botToken'])
    // The relay needs no secret, so nothing gates the assignment.
    expect(provider.secretShape.httpAssignRequires).toEqual([])
  })

  it('projects the D6 identity with the tenantless sentinel', () => {
    const input: CreateBotInput = {
      id: bot().id,
      orgId: ORG,
      platform: 'googlechat',
      name: bot().name,
      externalAppId: PROJECT_NUMBER,
      platformConfig: { projectId: PROJECT_ID }
    }
    expect(provider.projectBotIdentity!(input)).toEqual({
      externalAppId: PROJECT_NUMBER,
      externalTenantId: '-',
      platformConfig: { projectId: PROJECT_ID }
    })
    const { externalAppId: _, ...withoutApp } = input
    expect(provider.projectBotIdentity!(withoutApp)).toEqual({})
  })
})

describe('wire projections', () => {
  const provider = createGoogleChatCpProvider()
  const secrets = { botToken: JSON.stringify(KEY_FIELDS), appToken: null, signingSecret: null }

  it('hands the daemon the project, its number, and the key', async () => {
    const config = await provider.projectIntegrationConfig(integration(), bot(), CORE, secrets)
    expect(IntegrationGoogleChatConfig.parse(config)).toEqual({
      projectId: PROJECT_ID,
      projectNumber: PROJECT_NUMBER,
      serviceAccountKey: secrets.botToken
    })
  })

  it('withholds the integration from a row that lacks its app identity', async () => {
    expect(
      await provider.projectIntegrationConfig(integration(), bot({ externalAppId: null }), CORE, secrets)
    ).toBeUndefined()
    expect(
      await provider.projectIntegrationConfig(integration(), bot({ platformConfig: null }), CORE, secrets)
    ).toBeUndefined()
  })

  it('gives the relay only the project number, never the key', async () => {
    const bags = await provider.projectBotAssign!(bot(), secrets)
    expect(bags).toEqual({ secrets: {}, ingress: { apiAppId: PROJECT_NUMBER } })
    expect(JSON.stringify(bags)).not.toContain('PRIVATE KEY')
    expect(googleChatBotAssignBags(bot({ externalAppId: null }))).toEqual({ secrets: {}, ingress: {} })
  })
})

describe('composition', () => {
  it('contributes the injected install route at the org scope only, and owns the deployment app keys', () => {
    const route: FastifyPluginAsync = async () => {}
    const provider = createGoogleChatCpProvider({ installRoutes: { org: [route], publicCallback: [] } })
    expect(provider.platformId).toBe('googlechat')
    expect(provider.installRoutes('org')).toEqual([route])
    expect(provider.installRoutes('public-callback')).toEqual([])
    expect(Object.keys(GoogleChatCpEnvSchema)).toEqual([
      'GOOGLE_CHAT_PLATFORM_PROJECT_ID',
      'GOOGLE_CHAT_PLATFORM_PROJECT_NUMBER',
      'GOOGLE_CHAT_PLATFORM_SERVICE_ACCOUNT_KEY'
    ])
    expect(provider.envSchema).toBe(GoogleChatCpEnvSchema)
  })
})
