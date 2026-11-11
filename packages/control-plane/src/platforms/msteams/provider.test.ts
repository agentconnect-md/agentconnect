import { describe, expect, it, vi } from 'vitest'
import {
  IntegrationMsTeamsConfig,
  MSTEAMS_RELAY_EGRESS_V1_FEATURE,
  type IntegrationCoreEnvelope
} from '@agentconnect.md/protocol'
import {
  MSTEAMS_TOKEN_SCOPE,
  createMsTeamsCpProvider,
  msTeamsTokenUrl,
  verifyMsTeamsApp,
  type MsTeamsCreateCredentials
} from './provider.js'
import { MSTEAMS_DEPLOYMENT_SECRET_MARKER } from './deployment-app.js'
import { buildCpPlatformRegistry } from '../registry.js'
import { buildCreateIntegrationBody } from '../../http/dto/create-integration-body.js'
import type { BotRecord, CreateBotInput, IntegrationRecord } from '../../persistence/ports.js'

const APP_ID = '00000000-0000-4000-8000-0000000000a1'
const TENANT_ID = '00000000-0000-4000-8000-0000000000b2'
const SECRET = 'example-client-secret'
const credentials: MsTeamsCreateCredentials = { appId: APP_ID, tenantId: TENANT_ID, clientSecret: SECRET }

const respond = (status: number, body: unknown) =>
  vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json(body, { status }))
const entraError = (status: number, error: string, code: number) =>
  respond(status, { error, error_description: `AADSTS${code}: example`, error_codes: [code] })

describe('Teams credential check', () => {
  it('requests a Bot Framework token from the tenant endpoint', async () => {
    const fetchImpl = respond(200, { token_type: 'Bearer', expires_in: 3599, access_token: 'example-token' })
    const result = await verifyMsTeamsApp(credentials, fetchImpl)
    expect(result).toEqual({
      ok: true,
      identity: { name: `Microsoft Teams · ${APP_ID}`, externalAppId: APP_ID }
    })
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`)
    expect(url).toBe(msTeamsTokenUrl(TENANT_ID))
    expect(init?.method).toBe('POST')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      grant_type: 'client_credentials',
      client_id: APP_ID,
      client_secret: SECRET,
      scope: MSTEAMS_TOKEN_SCOPE
    })
  })

  it('names each definitive Entra refusal with its own 400 code', async () => {
    const cases: [ReturnType<typeof respond>, string][] = [
      [entraError(401, 'invalid_client', 7000215), 'MSTEAMS_SECRET_INVALID'],
      [entraError(401, 'invalid_client', 7000222), 'MSTEAMS_SECRET_INVALID'],
      [entraError(400, 'unauthorized_client', 700016), 'MSTEAMS_APP_NOT_FOUND'],
      [entraError(400, 'invalid_request', 90002), 'MSTEAMS_TENANT_NOT_FOUND'],
      [entraError(400, 'invalid_request', 900023), 'MSTEAMS_TENANT_NOT_FOUND'],
      [entraError(400, 'invalid_scope', 70011), 'MSTEAMS_CREDENTIALS_INVALID'],
      [respond(400, 'not json'), 'MSTEAMS_CREDENTIALS_INVALID']
    ]
    for (const [fetchImpl, code] of cases) {
      const result = await verifyMsTeamsApp(credentials, fetchImpl)
      expect(result, code).toMatchObject({ ok: false, status: 400, code })
      expect(JSON.stringify(result)).not.toContain('AADSTS')
      expect(JSON.stringify(result)).not.toContain(SECRET)
    }
  })

  it('answers 503 when Entra cannot be reached or answers inconclusively', async () => {
    for (const fetchImpl of [
      respond(500, {}),
      respond(503, {}),
      respond(429, {}),
      respond(200, {}),
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
      vi.fn(async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      })
    ]) {
      expect(await verifyMsTeamsApp(credentials, fetchImpl)).toMatchObject({
        ok: false,
        status: 503,
        code: 'MSTEAMS_CHECK_UNAVAILABLE'
      })
    }
  })

  it('validates through the injected fetch', async () => {
    const fetchImpl = respond(200, { access_token: 'example-token' })
    const result = await createMsTeamsCpProvider({ fetch: fetchImpl }).validateConfig(credentials, 'http')
    expect(result.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
})

describe('Teams installation', () => {
  it('keeps the client secret for the daemon and keys the bot by app and tenant', () => {
    const install = createMsTeamsCpProvider().buildNewBotInstall({
      credentials,
      identity: {},
      transport: 'http',
      shareable: true
    })
    expect(install.secrets).toEqual({ botToken: SECRET, appToken: null, signingSecret: null })
    expect(install.externalIdentity).toMatchObject({ externalAppId: APP_ID, externalTenantId: TENANT_ID })
    expect(install.bot).toEqual({ externalAppId: APP_ID, platformConfig: { tenantId: TENANT_ID } })
    expect(JSON.stringify(install.bot)).not.toContain(SECRET)
  })

  it('projects the tenant as the row key, not as metadata', () => {
    const project = createMsTeamsCpProvider().projectBotIdentity!
    expect(
      project({ externalAppId: APP_ID, platformConfig: { tenantId: TENANT_ID } } as unknown as CreateBotInput)
    ).toEqual({
      externalAppId: APP_ID,
      externalTenantId: TENANT_ID
    })
    expect(project({ externalAppId: APP_ID } as CreateBotInput)).toEqual({})
    const HOME = '66666666-6666-4666-8666-666666666666'
    expect(
      project({
        externalAppId: APP_ID,
        platformConfig: { tenantId: TENANT_ID, tokenTenantId: HOME }
      } as unknown as CreateBotInput)
    ).toEqual({ externalAppId: APP_ID, externalTenantId: TENANT_ID, platformConfig: { tokenTenantId: HOME } })
  })

  it('assigns the relay the app, the tenant and the bot mention identity only', async () => {
    const provider = createMsTeamsCpProvider()
    expect(provider.secretShape.httpAssignRequires).toEqual([])
    const bags = await provider.projectBotAssign!({ externalAppId: APP_ID, externalTenantId: TENANT_ID } as BotRecord, {
      botToken: SECRET,
      appToken: null,
      signingSecret: null
    })
    expect(bags).toEqual({
      secrets: {},
      ingress: { apiAppId: APP_ID, botUserId: `28:${APP_ID}`, teamId: TENANT_ID }
    })
  })

  it('projects the daemon config with the messaging endpoint under the relay origin', async () => {
    const bot = { externalAppId: APP_ID, externalTenantId: TENANT_ID } as BotRecord
    const secrets = { botToken: SECRET, appToken: null, signingSecret: null }
    const project = (publicRelayUrl?: string) =>
      createMsTeamsCpProvider(publicRelayUrl ? { publicRelayUrl } : {}).projectIntegrationConfig(
        {} as IntegrationRecord,
        bot,
        {} as IntegrationCoreEnvelope,
        secrets
      )
    expect(IntegrationMsTeamsConfig.parse(await project('https://relay.example.test/'))).toEqual({
      appId: APP_ID,
      tenantId: TENANT_ID,
      clientSecret: SECRET,
      messagesUrl: 'https://relay.example.test/msteams/messages'
    })
    expect(await project()).toEqual({ appId: APP_ID, tenantId: TENANT_ID, clientSecret: SECRET })
    expect(
      await createMsTeamsCpProvider().projectIntegrationConfig(
        {} as IntegrationRecord,
        bot,
        {} as IntegrationCoreEnvelope,
        { ...secrets, botToken: '' }
      )
    ).toBeUndefined()
  })

  it('projects a deployment app’s row with no secret, only the relay as its egress and its bot row (§8.5)', async () => {
    const HOME = '66666666-6666-4666-8666-666666666666'
    const BOT_ROW = '77777777-7777-4777-8777-777777777777'
    const app = { appId: APP_ID, tenantId: HOME, clientSecret: 'deployment-secret-example' }
    const row = {
      id: BOT_ROW,
      externalAppId: APP_ID,
      externalTenantId: TENANT_ID,
      platformConfig: { tenantId: TENANT_ID, tokenTenantId: HOME }
    } as unknown as BotRecord
    const project = (provider: ReturnType<typeof createMsTeamsCpProvider>, botToken: string) =>
      provider.projectIntegrationConfig({} as IntegrationRecord, row, {} as IntegrationCoreEnvelope, {
        botToken,
        appToken: null,
        signingSecret: null
      })
    const relayed = { appId: APP_ID, tenantId: TENANT_ID, egress: 'relay', botId: BOT_ROW }
    // A row an older build stamped with the secret still never ships it.
    for (const stored of [app.clientSecret, MSTEAMS_DEPLOYMENT_SECRET_MARKER]) {
      const config = await project(createMsTeamsCpProvider({ app }), stored)
      expect(config).toEqual(relayed)
      expect(IntegrationMsTeamsConfig.parse(config)).toEqual(relayed)
      expect(JSON.stringify(config)).not.toContain(app.clientSecret)
    }
    const provider = createMsTeamsCpProvider({ app })
    expect(provider.requiredDaemonFeatures!(relayed)).toEqual([MSTEAMS_RELAY_EGRESS_V1_FEATURE])
    // With the app unset or replaced, a row an older build stamped delivers nothing, never its stored secret.
    const replaced = createMsTeamsCpProvider({ app: { ...app, appId: '99999999-9999-4999-8999-999999999999' } })
    for (const deployment of [createMsTeamsCpProvider(), replaced])
      for (const stored of [app.clientSecret, MSTEAMS_DEPLOYMENT_SECRET_MARKER])
        expect(await project(deployment, stored)).toBeUndefined()
    // A prebuilt row from before the token tenant was recorded is one too.
    const prebuilt = { ...row, prebuilt: true, platformConfig: { tenantId: TENANT_ID } } as unknown as BotRecord
    expect(
      await createMsTeamsCpProvider().projectIntegrationConfig(
        {} as IntegrationRecord,
        prebuilt,
        {} as IntegrationCoreEnvelope,
        { botToken: app.clientSecret, appToken: null, signingSecret: null }
      )
    ).toBeUndefined()
    // An organization's own bot keeps its secret, and needs no feature.
    const own = {
      ...row,
      externalAppId: '88888888-8888-4888-8888-888888888888',
      prebuilt: false,
      platformConfig: {}
    } as unknown as BotRecord
    expect(
      await createMsTeamsCpProvider({ app }).projectIntegrationConfig(
        {} as IntegrationRecord,
        own,
        {} as IntegrationCoreEnvelope,
        { botToken: SECRET, appToken: null, signingSecret: null }
      )
    ).toEqual({ appId: own.externalAppId, tenantId: TENANT_ID, clientSecret: SECRET })
    expect(provider.requiredDaemonFeatures!({ appId: APP_ID, tenantId: TENANT_ID, clientSecret: SECRET })).toEqual([])
  })

  it('treats an agent bot’s row as the deployment’s while its blueprint is the configured one (§8.6.4)', async () => {
    const HOME = '66666666-6666-4666-8666-666666666666'
    const BOT_ROW = '77777777-7777-4777-8777-777777777777'
    const IDENTITY = '88888888-8888-4888-8888-888888888888'
    const BLUEPRINT = '99999999-9999-4999-8999-999999999999'
    const app = { appId: APP_ID, tenantId: HOME, clientSecret: 'deployment-secret-example' }
    const agentBot = { agentBotBlueprintId: BLUEPRINT, agentBotResourceName: 'agentconnect-example' }
    const stored = { tenantId: TENANT_ID, tokenTenantId: TENANT_ID, appOwner: 'deployment', ...agentBot }
    const row = {
      id: BOT_ROW,
      externalAppId: IDENTITY,
      externalTenantId: TENANT_ID,
      prebuilt: true,
      platformConfig: stored
    } as unknown as BotRecord
    const marker = { botToken: MSTEAMS_DEPLOYMENT_SECRET_MARKER, appToken: null, signingSecret: null }
    const project = (provider: ReturnType<typeof createMsTeamsCpProvider>) =>
      provider.projectIntegrationConfig({} as IntegrationRecord, row, {} as IntegrationCoreEnvelope, marker)

    const configured = createMsTeamsCpProvider({ app, agentBots: { blueprintId: BLUEPRINT } })
    expect(await project(configured)).toEqual({ appId: IDENTITY, tenantId: TENANT_ID, egress: 'relay', botId: BOT_ROW })
    // With agent bots off, another blueprint, or no app, the row delivers nothing.
    for (const other of [
      createMsTeamsCpProvider({ app }),
      createMsTeamsCpProvider({ app, agentBots: { blueprintId: APP_ID } }),
      createMsTeamsCpProvider({ agentBots: { blueprintId: BLUEPRINT } })
    ])
      expect(await project(other)).toBeUndefined()

    // The relay is told the row is an agent bot, the identity projection keeps what names it, and a freed row is released.
    expect((await configured.projectBotAssign!(row, marker)).ingress).toEqual({
      apiAppId: IDENTITY,
      botUserId: `28:${IDENTITY}`,
      teamId: TENANT_ID,
      agentBot: true
    })
    expect(
      configured.projectBotIdentity!({ externalAppId: IDENTITY, platformConfig: stored } as unknown as CreateBotInput)
    ).toEqual({
      externalAppId: IDENTITY,
      externalTenantId: TENANT_ID,
      platformConfig: { tokenTenantId: TENANT_ID, appOwner: 'deployment', ...agentBot }
    })
    expect(configured.releasesFreedBot!(row)).toBe(true)
    // A malformed entry is not an agent bot.
    const malformed = {
      ...row,
      platformConfig: { ...stored, agentBotResourceName: '' }
    } as unknown as BotRecord
    expect((await configured.projectBotAssign!(malformed, marker)).ingress).not.toHaveProperty('agentBot')
  })

  it('exposes the credential block through the actual create schema, lower-casing both IDs', () => {
    const schema = buildCreateIntegrationBody(buildCpPlatformRegistry([createMsTeamsCpProvider()]))
    const agentId = '00000000-0000-4000-8000-000000000001'
    const upper = { ...credentials, appId: APP_ID.toUpperCase(), tenantId: ` ${TENANT_ID.toUpperCase()} ` }
    const parsed = schema.safeParse({ platform: 'msteams', agentId, transport: 'http', msteams: upper })
    expect(parsed.success).toBe(true)
    expect((parsed.data as unknown as { msteams: MsTeamsCreateCredentials }).msteams).toEqual(credentials)
    for (const bad of [{ appId: 'not-a-guid' }, { tenantId: 'example.onmicrosoft.com' }, { clientSecret: '' }]) {
      expect(
        schema.safeParse({ platform: 'msteams', agentId, transport: 'http', msteams: { ...credentials, ...bad } })
          .success
      ).toBe(false)
    }
  })

  it('refuses the socket transport', () => {
    const schema = buildCreateIntegrationBody(buildCpPlatformRegistry([createMsTeamsCpProvider()]))
    const agentId = '00000000-0000-4000-8000-000000000001'
    expect(schema.safeParse({ platform: 'msteams', agentId, msteams: credentials }).success).toBe(false)
    expect(schema.safeParse({ platform: 'msteams', agentId, transport: 'socket', msteams: credentials }).success).toBe(
      false
    )
  })
})
