import { describe, expect, it, vi } from 'vitest'
import { IntegrationMsTeamsConfig, type IntegrationCoreEnvelope } from '@agentconnect.md/protocol'
import {
  MSTEAMS_TOKEN_SCOPE,
  createMsTeamsCpProvider,
  msTeamsTokenUrl,
  verifyMsTeamsApp,
  type MsTeamsCreateCredentials
} from './provider.js'
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
    const HOME = '66666666-6666-4666-8666-666666666666'
    expect(
      await createMsTeamsCpProvider().projectIntegrationConfig(
        {} as IntegrationRecord,
        { ...bot, platformConfig: { tenantId: TENANT_ID, tokenTenantId: HOME } },
        {} as IntegrationCoreEnvelope,
        secrets
      )
    ).toEqual({ appId: APP_ID, tenantId: TENANT_ID, tokenTenantId: HOME, clientSecret: SECRET })
    expect(
      await createMsTeamsCpProvider().projectIntegrationConfig(
        {} as IntegrationRecord,
        bot,
        {} as IntegrationCoreEnvelope,
        { ...secrets, botToken: '' }
      )
    ).toBeUndefined()
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
