import { describe, expect, it, vi } from 'vitest'
import { IntegrationDingTalkConfig, type IntegrationCoreEnvelope } from '@agentconnect.md/protocol'
import { DINGTALK_TOKEN_URL, createDingTalkCpProvider, verifyDingTalkApp } from './provider.js'
import { buildCpPlatformRegistry } from '../registry.js'
import { buildCreateIntegrationBody } from '../../http/dto/create-integration-body.js'
import type { BotRecord, IntegrationRecord } from '../../persistence/ports.js'

const credentials = { clientId: 'dingexampleclient', clientSecret: 'example-secret' }
const respond = (status: number, body: unknown) =>
  vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json(body, { status }))

describe('DingTalk credential check', () => {
  it('exchanges the Client ID and Secret for an access token at the mainland API', async () => {
    const fetchImpl = respond(200, { accessToken: 'example-token', expireIn: 7200 })
    const result = await verifyDingTalkApp(credentials, fetchImpl)
    expect(result).toEqual({
      ok: true,
      identity: { name: 'DingTalk · dingexampleclient', externalAppId: 'dingexampleclient' }
    })
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe(DINGTALK_TOKEN_URL)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ appKey: 'dingexampleclient', appSecret: 'example-secret' })
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
    expect(fetchImpl).toHaveBeenCalledOnce()
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
  })

  it('has no relay path and stores the app id under the tenantless sentinel', () => {
    const provider = createDingTalkCpProvider()
    expect(provider.projectBotAssign).toBeUndefined()
    expect(provider.secretShape.httpAssignRequires).toEqual([])
    expect(provider.projectBotIdentity?.({ externalAppId: 'dingexampleclient' } as never)).toEqual({
      externalAppId: 'dingexampleclient',
      externalTenantId: '-'
    })
  })

  it('projects the integration config the daemon reads', async () => {
    const config = await createDingTalkCpProvider().projectIntegrationConfig(
      {} as IntegrationRecord,
      { externalAppId: 'dingexampleclient' } as BotRecord,
      {} as IntegrationCoreEnvelope,
      { botToken: 'example-secret', appToken: 'dingexampleclient', signingSecret: null }
    )
    expect(IntegrationDingTalkConfig.parse(config)).toEqual({
      clientId: 'dingexampleclient',
      clientSecret: 'example-secret'
    })
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
