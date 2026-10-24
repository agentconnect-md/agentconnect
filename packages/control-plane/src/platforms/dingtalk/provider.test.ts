import { describe, expect, it, vi } from 'vitest'
import { IntegrationDingTalkConfig, type IntegrationCoreEnvelope } from '@agentconnect.md/protocol'
import { DINGTALK_TOKEN_URLS, createDingTalkCpProvider, verifyDingTalkApp } from './provider.js'
import { buildCpPlatformRegistry } from '../registry.js'
import { buildCreateIntegrationBody } from '../../http/dto/create-integration-body.js'
import type { BotRecord, IntegrationRecord } from '../../persistence/ports.js'

const credentials = { clientId: 'dingexampleclient', clientSecret: 'example-secret', edition: 'mainland' as const }
const respond = (status: number, body: unknown) =>
  vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json(body, { status }))
// Each edition's token endpoint accepts only its own apps, as DingTalk answers a foreign app's credentials.
const homeOn = (home: 'mainland' | 'international', foreign = 400) =>
  vi.fn(async (input: string | URL | Request, _init?: RequestInit) =>
    String(input) === DINGTALK_TOKEN_URLS[home]
      ? Response.json({ accessToken: 'example-token', expireIn: 7200 })
      : Response.json({ code: 'invalidClientIdOrSecret', message: 'invalid' }, { status: foreign })
  )

describe('DingTalk credential check', () => {
  it('exchanges the Client ID and Secret for an access token at the chosen edition', async () => {
    const fetchImpl = respond(200, { accessToken: 'example-token', expireIn: 7200 })
    const result = await verifyDingTalkApp(credentials, fetchImpl)
    expect(result).toEqual({
      ok: true,
      identity: {
        name: 'DingTalk · dingexampleclient',
        // An app list naming no robot leaves the bot its bare Client ID.
        botName: 'dingexampleclient',
        externalAppId: 'dingexampleclient',
        platformConfig: { edition: 'mainland' }
      }
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe(DINGTALK_TOKEN_URLS.mainland)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ appKey: 'dingexampleclient', appSecret: 'example-secret' })
  })

  it('checks an international app at the international API only', async () => {
    const fetchImpl = homeOn('international')
    expect(await verifyDingTalkApp({ ...credentials, edition: 'international' }, fetchImpl)).toMatchObject({
      ok: true,
      identity: { platformConfig: { edition: 'international' } }
    })
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      DINGTALK_TOKEN_URLS.international,
      'https://api.dingtalk.io/v1.0/microApp/allInnerApps'
    ])
  })

  it("names the bot after the robot the organization's app list gives this Client ID", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, _init?: RequestInit) =>
      String(input).endsWith('/oauth2/accessToken')
        ? Response.json({ accessToken: 'example-token', expireIn: 7200 })
        : Response.json({
            appList: [
              { name: 'OtherApp', robotInfo: { name: 'Other Robot', robotCode: 'dingotherclient' } },
              { name: 'ExampleApp', robotInfo: { name: ' Example Robot ', robotCode: 'dingexampleclient' } }
            ]
          })
    )
    expect(await verifyDingTalkApp(credentials, fetchImpl)).toMatchObject({
      ok: true,
      identity: { name: 'DingTalk · dingexampleclient', botName: 'Example Robot' }
    })
    expect(fetchImpl.mock.calls[1]![1]?.headers).toEqual({ 'x-acs-dingtalk-access-token': 'example-token' })
  })

  it('names the other edition when the app belongs to it', async () => {
    expect(await verifyDingTalkApp(credentials, homeOn('international'))).toMatchObject({
      ok: false,
      status: 400,
      code: 'DINGTALK_APP_IS_INTERNATIONAL'
    })
    expect(await verifyDingTalkApp({ ...credentials, edition: 'international' }, homeOn('mainland'))).toMatchObject({
      ok: false,
      status: 400,
      code: 'DINGTALK_APP_IS_MAINLAND'
    })
  })

  it('names rejected credentials apart from an unreachable service', async () => {
    const rejected = await verifyDingTalkApp(
      credentials,
      respond(400, { code: 'invalidClientIdOrSecret', message: 'invalid' })
    )
    expect(rejected).toMatchObject({ ok: false, status: 400, code: 'DINGTALK_CREDENTIALS_INVALID' })
    for (const fetchImpl of [
      respond(503, {}),
      respond(429, {}),
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      })
    ]) {
      expect(await verifyDingTalkApp(credentials, fetchImpl)).toMatchObject({
        ok: false,
        status: 503,
        code: 'DINGTALK_CHECK_UNAVAILABLE'
      })
    }
  })

  it('validates through the injected fetch', async () => {
    const fetchImpl = respond(200, { accessToken: 'example-token', expireIn: 7200 })
    const result = await createDingTalkCpProvider({ fetch: fetchImpl }).validateConfig(credentials, 'socket')
    expect(result.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('DingTalk installation', () => {
  it('packs the secret slots as Lark / Feishu does and fences one bot per app', () => {
    const install = createDingTalkCpProvider().buildNewBotInstall({
      credentials,
      identity: {},
      transport: 'socket',
      shareable: false
    })
    expect(install.secrets).toEqual({ botToken: 'example-secret', appToken: 'dingexampleclient', signingSecret: null })
    expect(install.externalIdentity).toMatchObject({ externalAppId: 'dingexampleclient', externalTenantId: '-' })
    expect(JSON.stringify(install.bot)).not.toContain('example-secret')
    expect(install.bot?.platformConfig).toEqual({ edition: 'mainland' })
  })

  it('has no relay path and stores the app id under the tenantless sentinel', () => {
    const provider = createDingTalkCpProvider()
    expect(provider.projectBotAssign).toBeUndefined()
    expect(provider.secretShape.httpAssignRequires).toEqual([])
    expect(provider.projectBotIdentity?.({ externalAppId: 'dingexampleclient' } as never)).toEqual({
      externalAppId: 'dingexampleclient',
      externalTenantId: '-'
    })
    expect(
      provider.projectBotIdentity?.({
        externalAppId: 'dingexampleclient',
        platformConfig: { edition: 'international' }
      } as never)
    ).toMatchObject({ platformConfig: { edition: 'international' } })
  })

  it('projects the integration config the daemon reads, with the bot edition', async () => {
    const project = (bot: Partial<BotRecord>) =>
      createDingTalkCpProvider().projectIntegrationConfig(
        {} as IntegrationRecord,
        { externalAppId: 'dingexampleclient', ...bot } as BotRecord,
        {} as IntegrationCoreEnvelope,
        { botToken: 'example-secret', appToken: 'dingexampleclient', signingSecret: null }
      )
    expect(IntegrationDingTalkConfig.parse(await project({ platformConfig: null }))).toEqual({
      clientId: 'dingexampleclient',
      clientSecret: 'example-secret',
      edition: 'mainland'
    })
    expect(await project({ platformConfig: { edition: 'international' } })).toMatchObject({ edition: 'international' })
  })

  it('exposes the credential block through the actual create schema', () => {
    const schema = buildCreateIntegrationBody(buildCpPlatformRegistry([createDingTalkCpProvider()]))
    const agentId = '00000000-0000-4000-8000-000000000001'
    expect(schema.safeParse({ platform: 'dingtalk', agentId, dingtalk: credentials }).success).toBe(true)
    expect(
      schema.safeParse({ platform: 'dingtalk', agentId, dingtalk: { ...credentials, clientId: 'not an id' } }).success
    ).toBe(false)
  })
})

describe('DingTalk organization name', () => {
  it('reads it on the bot edition host with the app token, and names the integration after it', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, _init?: RequestInit) =>
      String(input).endsWith('/oauth2/accessToken')
        ? Response.json({ accessToken: 'example-token', expireIn: 7200 })
        : Response.json({ orgName: ' Example Org ' })
    )
    const tenant = createDingTalkCpProvider({ fetch: fetchImpl }).socketTenant!
    const bot = { externalAppId: 'dingexampleclient', platformConfig: { edition: 'international' } } as never
    const secrets = { botToken: 'example-secret', appToken: 'dingexampleclient', signingSecret: null }

    expect(tenant.matches(bot, 'dingexampleclient')).toBe(true)
    expect(tenant.matches(bot, 'dingotherclient')).toBe(false)
    expect(await tenant.name(bot, secrets, 'dingexamplecorp')).toEqual({
      workspaceName: 'Example Org',
      integrationName: { placeholder: 'DingTalk · dingexampleclient', name: 'DingTalk · Example Org' }
    })
    const [, read] = fetchImpl.mock.calls
    expect(String(read![0])).toBe(
      'https://api.dingtalk.io/v1.0/contact/organizations/authInfos?targetCorpId=dingexamplecorp'
    )
    expect(read![1]?.headers).toEqual({ 'x-acs-dingtalk-access-token': 'example-token' })
  })

  it('answers none without the permission', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, _init?: RequestInit) =>
      String(input).endsWith('/oauth2/accessToken')
        ? Response.json({ accessToken: 'example-token', expireIn: 7200 })
        : Response.json({ code: 'Forbidden.AccessDenied.AccessTokenPermissionDenied' }, { status: 403 })
    )
    const tenant = createDingTalkCpProvider({ fetch: fetchImpl }).socketTenant!
    const secrets = { botToken: 'example-secret', appToken: 'dingexampleclient', signingSecret: null }
    expect(await tenant.name({ platformConfig: null } as never, secrets, 'dingexamplecorp')).toEqual({
      unnamed: 'Forbidden.AccessDenied.AccessTokenPermissionDenied'
    })
  })
})
