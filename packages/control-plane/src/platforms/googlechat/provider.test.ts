/** Google Chat CpPlatformProvider (google-chat-integration.md §3, §7) — unit, against a fake Google HTTP layer. */
import { generateKeyPairSync } from 'node:crypto'
import { describe, it, expect, vi } from 'vitest'
import type { FastifyPluginAsync } from 'fastify'
import { IntegrationGoogleChatConfig, manifestFor, type IntegrationCoreEnvelope } from '@agentconnect.md/protocol'
import {
  createGoogleChatCpProvider,
  GOOGLE_CHAT_APP_TAKEN_MESSAGE,
  GOOGLE_CHAT_DEPLOYMENT_APP_MESSAGE,
  GoogleChatCpEnvSchema,
  googleChatBotAssignBags,
  googleChatClaimAnchor,
  googleChatRowKind,
  googleChatRowShadowsAnchor,
  buildGoogleChatInstall
} from './provider.js'
import { GOOGLE_CHAT_CLAIM_TAKEN_MESSAGE } from './tenant.js'
import { decodeJwt } from 'jose'
import {
  GOOGLE_CHAT_BOT_SCOPE,
  GOOGLE_CHAT_PROBE_URL,
  GOOGLE_CLOUD_READ_ONLY_SCOPE,
  GOOGLE_TOKEN_ENDPOINT,
  googleCloudProjectUrl
} from './credential.js'
import { buildCpPlatformRegistry } from '../registry.js'
import { toBotDto } from '../../http/routes/bots.js'
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

type GoogleAnswer = 'ok' | 'rejected' | 'offline' | 'no_app' | 'crm_disabled' | 'crm_forbidden'
const CRM_URL = googleCloudProjectUrl(PROJECT_ID)

/** Answers Google's token endpoint, Cloud Resource Manager, and the one Chat API read, recording every call and token scope. */
function fakeGoogle(answer: GoogleAnswer = 'ok', spaces: unknown[] = []) {
  const calls: { method: string; url: string; scope?: string }[] = []
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    const assertion = url === GOOGLE_TOKEN_ENDPOINT ? new URLSearchParams(String(init.body)).get('assertion') : null
    calls.push({
      method: init.method ?? 'GET',
      url,
      ...(assertion ? { scope: String(decodeJwt(assertion).scope) } : {})
    })
    if (answer === 'offline') throw new TypeError('fetch failed')
    if (url === GOOGLE_TOKEN_ENDPOINT) {
      return answer === 'rejected'
        ? Response.json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, { status: 400 })
        : Response.json({ access_token: 'synthetic-access-token', token_type: 'Bearer', expires_in: 3599 })
    }
    if (url === CRM_URL) {
      if (answer === 'crm_disabled' || answer === 'crm_forbidden') {
        const details = answer === 'crm_disabled' ? [{ reason: 'SERVICE_DISABLED' }] : []
        return Response.json(
          { error: { code: 403, status: 'PERMISSION_DENIED', message: 'denied', details } },
          { status: 403 }
        )
      }
      return Response.json({ projectNumber: PROJECT_NUMBER, projectId: PROJECT_ID })
    }
    if (url === GOOGLE_CHAT_PROBE_URL) {
      return answer === 'no_app'
        ? Response.json({ error: { code: 404, message: 'Google Chat app not found.' } }, { status: 404 })
        : Response.json({ spaces })
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
  it('resolves the project number with a read-only token, then makes one Chat API read, and sends nothing', async () => {
    const google = fakeGoogle()
    const result = await createGoogleChatCpProvider({ fetch: google.fetchImpl }).validateConfig(CREDENTIALS, 'http')

    expect(result).toEqual({
      ok: true,
      identity: { name: `Google Chat · ${PROJECT_ID}`, externalAppId: PROJECT_NUMBER }
    })
    expect(google.calls).toEqual([
      { method: 'POST', url: GOOGLE_TOKEN_ENDPOINT, scope: GOOGLE_CLOUD_READ_ONLY_SCOPE },
      { method: 'GET', url: CRM_URL },
      { method: 'POST', url: GOOGLE_TOKEN_ENDPOINT, scope: GOOGLE_CHAT_BOT_SCOPE },
      { method: 'GET', url: GOOGLE_CHAT_PROBE_URL }
    ])
  })

  it('takes the identity from the key’s project when no number is entered', async () => {
    const { projectNumber: _, ...withoutNumber } = CREDENTIALS
    const result = await createGoogleChatCpProvider({ fetch: fakeGoogle().fetchImpl }).validateConfig(
      withoutNumber,
      'http'
    )
    expect(result).toMatchObject({ ok: true, identity: { externalAppId: PROJECT_NUMBER } })
  })

  it('refuses an entered number that is not the key’s project, naming both, before the Chat API read', async () => {
    const google = fakeGoogle()
    const result = await createGoogleChatCpProvider({ fetch: google.fetchImpl }).validateConfig(
      { ...CREDENTIALS, projectNumber: '210987654321' },
      'http'
    )
    expect(result).toEqual({
      ok: false,
      status: 400,
      code: 'GOOGLE_CHAT_PROJECT_NUMBER_MISMATCH',
      message: `the project number 210987654321 does not match project ${PROJECT_ID}, whose number is ${PROJECT_NUMBER}`
    })
    expect(google.calls.map((call) => call.url)).not.toContain(GOOGLE_CHAT_PROBE_URL)
  })

  it('refuses a key whose project_id was edited to claim another project, before calling Google', async () => {
    const google = fakeGoogle()
    const result = await createGoogleChatCpProvider({ fetch: google.fetchImpl }).validateConfig(
      {
        projectId: 'other-example-project',
        serviceAccountKey: JSON.stringify({ ...KEY_FIELDS, project_id: 'other-example-project' })
      },
      'http'
    )
    expect(result).toMatchObject({ ok: false, status: 400, code: 'GOOGLE_CHAT_KEY_INVALID' })
    expect(google.calls).toEqual([])
  })

  it('answers a disabled Cloud Resource Manager API and a missing Browser role with their own codes', async () => {
    const disabled = await createGoogleChatCpProvider({ fetch: fakeGoogle('crm_disabled').fetchImpl }).validateConfig(
      CREDENTIALS,
      'http'
    )
    expect(disabled).toMatchObject({
      ok: false,
      status: 400,
      code: 'GOOGLE_CHAT_CRM_DISABLED',
      message: expect.stringMatching(/^Enable the Cloud Resource Manager API in project example-project/)
    })
    const forbidden = await createGoogleChatCpProvider({ fetch: fakeGoogle('crm_forbidden').fetchImpl }).validateConfig(
      CREDENTIALS,
      'http'
    )
    expect(forbidden).toMatchObject({
      ok: false,
      status: 400,
      code: 'GOOGLE_CHAT_CRM_FORBIDDEN',
      message: expect.stringMatching(/the Browser role on project example-project/)
    })
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

  it('stamps the one customer the probe’s Space list proves as the row’s own fence, and none for several (§10.3)', async () => {
    const provider = createGoogleChatCpProvider({
      fetch: fakeGoogle('ok', [{ name: 'spaces/A', spaceType: 'SPACE', customer: 'customers/C0000000001' }]).fetchImpl
    })
    const one = await provider.validateConfig(CREDENTIALS, 'http')
    expect(one).toMatchObject({ ok: true, identity: { platformConfig: { customerId: 'C0000000001' } } })
    const install = provider.buildNewBotInstall({
      credentials: CREDENTIALS,
      identity: (one as { identity: { externalAppId: string; platformConfig?: Record<string, string> } }).identity,
      transport: 'http',
      shareable: false
    })
    // Stamped beside the tenantless key: a single-tenant row is never keyed by its customer.
    expect(install.bot).toEqual({
      externalAppId: PROJECT_NUMBER,
      platformConfig: { projectId: PROJECT_ID, customerId: 'C0000000001' }
    })
    expect(install.externalIdentity).toMatchObject({ externalAppId: PROJECT_NUMBER, externalTenantId: '-' })
    const two = createGoogleChatCpProvider({
      fetch: fakeGoogle('ok', [
        { name: 'spaces/A', spaceType: 'SPACE', customer: 'customers/C0000000001' },
        { name: 'spaces/B', spaceType: 'SPACE', customer: 'customers/C0000000002' }
      ]).fetchImpl
    })
    const several = await two.validateConfig(CREDENTIALS, 'http')
    if (!several.ok) throw new Error('expected the app to validate')
    expect(several.identity).not.toHaveProperty('platformConfig')
  })

  it('refuses the deployment’s own app with 409 once Google resolves it, pointing the organization at Google Chat', async () => {
    const google = fakeGoogle()
    const provider = createGoogleChatCpProvider({ fetch: google.fetchImpl, app: { projectNumber: PROJECT_NUMBER } })

    expect(await provider.validateConfig(CREDENTIALS, 'http')).toEqual({
      ok: false,
      status: 409,
      code: 'GOOGLE_CHAT_DEPLOYMENT_APP',
      message: GOOGLE_CHAT_DEPLOYMENT_APP_MESSAGE
    })
    // The resolved number decides, so an omitted one is refused all the same.
    const { projectNumber: _, ...withoutNumber } = CREDENTIALS
    expect(await provider.validateConfig(withoutNumber, 'http')).toMatchObject({ status: 409 })
    // Another deployment app leaves this per-agent app alone.
    const other = createGoogleChatCpProvider({ fetch: google.fetchImpl, app: { projectNumber: '210987654321' } })
    expect(await other.validateConfig(CREDENTIALS, 'http')).toMatchObject({ ok: true })
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

  it('carries the resolved project number as the app identity, never an entered one', () => {
    const install = provider.buildNewBotInstall({
      credentials: { ...CREDENTIALS, projectNumber: '210987654321' },
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
    expect(() =>
      provider.buildNewBotInstall({ credentials: CREDENTIALS, identity: {}, transport: 'http', shareable: false })
    ).toThrow(/resolved project number/)
  })

  it('stores the project of the key’s authenticated account, never the entered one', () => {
    const install = provider.buildNewBotInstall({
      credentials: { ...CREDENTIALS, projectId: 'entered-elsewhere' },
      identity,
      transport: 'http',
      shareable: false
    })
    expect(install.bot?.platformConfig).toEqual({ projectId: PROJECT_ID })
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

  it('keys a claimed customer row by its customer when known, else by its domain (§10.3)', () => {
    const input = (platformConfig: Record<string, string>): CreateBotInput => ({
      id: bot().id,
      orgId: ORG,
      platform: 'googlechat',
      name: bot().name,
      externalAppId: PROJECT_NUMBER,
      platformConfig: { projectId: PROJECT_ID, ...platformConfig }
    })
    expect(
      provider.projectBotIdentity!(input({ customerId: 'C0000000000', domainIds: '0000000000,0000000001' }))
    ).toEqual({
      externalAppId: PROJECT_NUMBER,
      externalTenantId: 'customers/C0000000000',
      platformConfig: { projectId: PROJECT_ID, customerId: 'C0000000000', domainIds: '0000000000,0000000001' }
    })
    expect(provider.projectBotIdentity!(input({ domainIds: '0000000000' }))).toEqual({
      externalAppId: PROJECT_NUMBER,
      externalTenantId: 'domains/0000000000',
      platformConfig: { projectId: PROJECT_ID, domainIds: '0000000000' }
    })
  })

  it('writes a customer row with a copy of the deployment key and a refusal that names no organization', () => {
    const install = buildGoogleChatInstall(
      { projectId: PROJECT_ID, projectNumber: PROJECT_NUMBER, serviceAccountKey: JSON.stringify(KEY_FIELDS, null, 2) },
      { domainIds: ['0000000000'] }
    )
    expect(install.bot).toEqual({
      externalAppId: PROJECT_NUMBER,
      platformConfig: { projectId: PROJECT_ID, domainIds: '0000000000' }
    })
    expect(install.secrets).toEqual({ botToken: JSON.stringify(KEY_FIELDS), appToken: null, signingSecret: null })
    expect(install.externalIdentity).toEqual({
      externalAppId: PROJECT_NUMBER,
      externalTenantId: 'domains/0000000000',
      conflictMessage: GOOGLE_CHAT_CLAIM_TAKEN_MESSAGE
    })
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

  it('names the relay’s events URL for an add-on’s card actions when the relay pool has a public origin (§11)', async () => {
    const served = createGoogleChatCpProvider({ publicRelayUrl: 'https://relay.example.test' })
    const config = await served.projectIntegrationConfig(integration(), bot(), CORE, secrets)
    expect(IntegrationGoogleChatConfig.parse(config)).toMatchObject({
      eventsUrl: 'https://relay.example.test/googlechat/events'
    })
    expect(await provider.projectIntegrationConfig(integration(), bot(), CORE, secrets)).not.toHaveProperty('eventsUrl')
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

  it("carries the app's users/… identity to the relay when the bot row stores one", async () => {
    const bags = await provider.projectBotAssign!(bot({ botUserId: 'users/100000000000000000009' }), secrets)
    expect(bags.ingress).toEqual({ apiAppId: PROJECT_NUMBER, appUserName: 'users/100000000000000000009' })
  })

  it('gives a customer row every tenant key it knows, one per domain', async () => {
    const customer = bot({
      externalTenantId: 'customers/C0000000000',
      platformConfig: { projectId: PROJECT_ID, customerId: 'C0000000000', domainIds: '0000000000,0000000001' }
    })
    expect((await provider.projectBotAssign!(customer, secrets)).ingress).toEqual({
      apiAppId: PROJECT_NUMBER,
      tenantIds: ['customers/C0000000000', 'domains/0000000000', 'domains/0000000001']
    })
    const domainOnly = bot({
      externalTenantId: 'domains/0000000000',
      platformConfig: { projectId: PROJECT_ID, domainIds: '0000000000' }
    })
    expect((await provider.projectBotAssign!(domainOnly, secrets)).ingress).toEqual({
      apiAppId: PROJECT_NUMBER,
      tenantIds: ['domains/0000000000']
    })
  })

  it('hands the daemon a customer row’s strict keys and a single-tenant row its own keys', async () => {
    const customer = bot({
      externalTenantId: 'customers/C0000000000',
      platformConfig: { projectId: PROJECT_ID, customerId: 'C0000000000', domainIds: '0000000000' }
    })
    expect(await provider.projectIntegrationConfig(integration(), customer, CORE, secrets)).toMatchObject({
      tenantIds: ['customers/C0000000000', 'domains/0000000000']
    })
    const stamped = bot({
      platformConfig: { projectId: PROJECT_ID, customerId: 'C0000000000', domainIds: '0000000000' }
    })
    const own = await provider.projectIntegrationConfig(integration(), stamped, CORE, secrets)
    expect(own).toMatchObject({ ownTenantIds: ['customers/C0000000000', 'domains/0000000000'] })
    expect(own).not.toHaveProperty('tenantIds')
    const bare = await provider.projectIntegrationConfig(integration(), bot(), CORE, secrets)
    expect(bare).not.toHaveProperty('tenantIds')
    expect(bare).not.toHaveProperty('ownTenantIds')
    expect(googleChatRowKind(customer)).toBe('customer')
    expect(googleChatRowKind(stamped)).toBe('single')
  })

  it('gives the relay a single-tenant row’s recorded keys as its own, never as customer keys', async () => {
    const stamped = bot({ platformConfig: { projectId: PROJECT_ID, customerId: 'C0000000000' } })
    expect((await provider.projectBotAssign!(stamped, secrets)).ingress).toEqual({
      apiAppId: PROJECT_NUMBER,
      ownTenantIds: ['customers/C0000000000']
    })
  })

  it('keeps a tenantless row of the deployment app off the relay and off the daemon, and nothing else', async () => {
    const deployment = createGoogleChatCpProvider({ app: { projectNumber: PROJECT_NUMBER } })
    const shadowing = bot()
    const customer = bot({ externalTenantId: 'customers/C0000000000' })
    const ownApp = bot({ externalAppId: '210987654321' })

    expect(googleChatRowShadowsAnchor(shadowing, PROJECT_NUMBER)).toBe(true)
    expect(deployment.relayAssignable!(shadowing)).toBe(false)
    expect(await deployment.projectIntegrationConfig(integration(), shadowing, CORE, secrets)).toBeUndefined()
    for (const served of [customer, ownApp]) {
      expect(deployment.relayAssignable!(served)).toBe(true)
      expect(await deployment.projectIntegrationConfig(integration(), served, CORE, secrets)).toBeDefined()
    }
    // Without a deployment app every tenantless row is some organization's own app.
    expect(provider.relayAssignable!(shadowing)).toBe(true)
    expect(googleChatBotAssignBags(shadowing).ingress).toEqual({ apiAppId: PROJECT_NUMBER })
  })

  it('anchors the relay at the claim page only for a configured app and an https console', () => {
    const app = { projectNumber: PROJECT_NUMBER }
    expect(googleChatClaimAnchor(app, 'https://console.example.test/')).toEqual({
      projectNumber: PROJECT_NUMBER,
      claimUrl: 'https://console.example.test/googlechat/claim'
    })
    expect(googleChatClaimAnchor(undefined, 'https://console.example.test')).toBeUndefined()
    expect(googleChatClaimAnchor(app, undefined)).toBeUndefined()
    expect(googleChatClaimAnchor(app, 'http://localhost:3000')).toBeUndefined()
    expect(googleChatClaimAnchor({ projectNumber: 'example-project' }, 'https://console.example.test')).toBeUndefined()
  })
})

describe('composition', () => {
  it('contributes the injected routes at the org scope only, and owns the deployment app keys', () => {
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
    // Google offers no app-authenticated read of the app's own identity, so there is nothing to poll.
    expect(provider.backgroundLoops).toBeUndefined()
  })

  it('declares the key re-stamp as its one background loop', () => {
    const credentialReconciler = { start: vi.fn(), stop: vi.fn() }
    const [loop, ...rest] = createGoogleChatCpProvider({ credentialReconciler }).backgroundLoops ?? []
    expect(rest).toEqual([])
    expect(loop?.label).toBe('googlechat-credential-restamp')
    loop?.start()
    loop?.stop()
    expect(credentialReconciler.start).toHaveBeenCalledOnce()
    expect(credentialReconciler.stop).toHaveBeenCalledOnce()
  })
})

describe('a single-tenant row learns its tenant, and a freed customer row is released (§10.3, §10.5)', () => {
  const single = createGoogleChatCpProvider()
  const deployment = createGoogleChatCpProvider({ app: { projectNumber: PROJECT_NUMBER } })
  const snapshot = (platformConfig: Record<string, unknown>, externalTenantId: string | null = '-') => ({
    platformConfig,
    externalTenantId
  })

  it('records a single-tenant row’s first customer and each new domain, knows them again, and refuses a second customer', () => {
    const row = bot()
    expect(single.learnTenant!(row, snapshot({ projectId: PROJECT_ID }), 'customers/C0000000001')).toEqual({
      kind: 'record',
      change: { platformConfig: { customerId: 'C0000000001' } }
    })
    const stamped = snapshot({ projectId: PROJECT_ID, customerId: 'C0000000001' })
    expect(single.learnTenant!(row, stamped, 'customers/C0000000001')).toEqual({ kind: 'known' })
    expect(single.learnTenant!(row, stamped, 'customers/C0000000002')).toMatchObject({ kind: 'refused' })
    expect(single.learnTenant!(row, stamped, 'domains/0000000001')).toEqual({
      kind: 'record',
      change: { platformConfig: { domainIds: '0000000001' } }
    })
  })

  it('refuses a report for a customer row, which learns only through claims, and for a tenantless row of the deployment app', () => {
    const customer = bot({ externalTenantId: 'customers/C0000000001' })
    expect(
      single.learnTenant!(customer, snapshot({ projectId: PROJECT_ID }, 'customers/C0000000001'), 'domains/0000000001')
    ).toMatchObject({ kind: 'refused' })
    expect(deployment.learnTenant!(bot(), snapshot({ projectId: PROJECT_ID }), 'customers/C0000000001')).toMatchObject({
      kind: 'refused'
    })
    // The same row is some organization's own app where the deployment has none of that project.
    expect(single.learnTenant!(bot(), snapshot({ projectId: PROJECT_ID }), 'customers/C0000000001')).toMatchObject({
      kind: 'record'
    })
  })

  it('releases a freed customer row for a new claim, and keeps a single-tenant row', () => {
    expect(deployment.releasesFreedBot!(bot({ externalTenantId: 'customers/C0000000001' }))).toBe(true)
    expect(deployment.releasesFreedBot!(bot({ externalTenantId: 'domains/0000000001' }))).toBe(true)
    expect(deployment.releasesFreedBot!(bot())).toBe(false)
    expect(single.releasesFreedBot!(bot())).toBe(false)
    // The bot DTO carries the same decision, so the console's delete confirmation can say the row goes with it.
    const registry = buildCpPlatformRegistry([deployment])
    expect(toBotDto(bot({ externalTenantId: 'customers/C0000000001' }), registry).releasedWhenFreed).toBe(true)
    expect(toBotDto(bot(), registry).releasedWhenFreed).toBe(false)
  })
})
