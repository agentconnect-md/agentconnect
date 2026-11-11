import { describe, expect, it, vi } from 'vitest'
import { IntegrationWeComConfig, type IntegrationCoreEnvelope } from '@agentconnect.md/protocol'
import {
  WECOM_LONG_CONNECTION_URL,
  createWeComCpProvider,
  verifyWeComBot,
  type WeComDial,
  type WeComSocketHandlers
} from './provider.js'
import { buildCpPlatformRegistry } from '../registry.js'
import { buildCreateIntegrationBody } from '../../http/dto/create-integration-body.js'
import type { BotRecord, IntegrationRecord } from '../../persistence/ports.js'

const credentials = { botId: 'aibot-example', secret: 'secret-placeholder' }

interface SubscribeFrame {
  cmd: string
  headers: { req_id: string }
  body: { bot_id: string; secret: string }
}

/** A fake long connection: `answer` maps the subscribe frame to what the server does next. */
function fakeWeCom(answer: (frame: SubscribeFrame, h: WeComSocketHandlers) => void, opts: { syncOpen?: boolean } = {}) {
  const urls: string[] = []
  const sent: SubscribeFrame[] = []
  let closes = 0
  const dial: WeComDial = (url, handlers) => {
    urls.push(url)
    if (opts.syncOpen) handlers.open()
    else queueMicrotask(() => handlers.open())
    return {
      send: (text) => {
        const frame = JSON.parse(text) as SubscribeFrame
        sent.push(frame)
        queueMicrotask(() => answer(frame, handlers))
      },
      close: () => {
        closes++
      }
    }
  }
  return { dial, urls, sent, closes: () => closes }
}

const reply =
  (errcode: number, errmsg = 'example') =>
  (frame: SubscribeFrame, h: WeComSocketHandlers) =>
    h.message(JSON.stringify({ headers: { req_id: frame.headers.req_id }, errcode, errmsg }))

describe('WeCom credential check', () => {
  it('subscribes once with the BotID and Secret, then closes the socket', async () => {
    const wecom = fakeWeCom(reply(0, 'ok'))
    const result = await verifyWeComBot(credentials, { dial: wecom.dial })
    expect(result).toEqual({ ok: true, identity: { name: 'WeCom · aibot-example', externalAppId: 'aibot-example' } })
    expect(wecom.urls).toEqual([WECOM_LONG_CONNECTION_URL])
    expect(wecom.sent).toHaveLength(1)
    expect(wecom.sent[0]).toMatchObject({
      cmd: 'aibot_subscribe',
      body: { bot_id: 'aibot-example', secret: 'secret-placeholder' }
    })
    expect(wecom.sent[0]!.headers.req_id).toMatch(/^aibot_subscribe_/)
    expect(wecom.closes()).toBe(1)
  })

  it('subscribes when the socket opens before the dial returns', async () => {
    const wecom = fakeWeCom(reply(0, 'ok'), { syncOpen: true })
    expect((await verifyWeComBot(credentials, { dial: wecom.dial })).ok).toBe(true)
    expect(wecom.sent).toHaveLength(1)
  })

  it('dials the configured endpoint', async () => {
    const wecom = fakeWeCom(reply(0, 'ok'))
    await verifyWeComBot(credentials, { dial: wecom.dial, url: 'wss://openws.example.test' })
    expect(wecom.urls).toEqual(['wss://openws.example.test'])
  })

  it('ignores pushes and answers to other requests while it waits for its own', async () => {
    const wecom = fakeWeCom((frame, h) => {
      h.message('not json')
      h.message(JSON.stringify({ cmd: 'aibot_event_callback', headers: { req_id: 'event-1' }, body: {} }))
      h.message(JSON.stringify({ headers: { req_id: 'ping_other' }, errcode: 853000, errmsg: 'other' }))
      reply(0, 'ok')(frame, h)
    })
    expect((await verifyWeComBot(credentials, { dial: wecom.dial })).ok).toBe(true)
  })

  it('names rejected credentials, a bot without long connection, and an unreachable service apart', async () => {
    for (const errcode of [853000, 40001, 40058]) {
      const wecom = fakeWeCom(reply(errcode))
      expect(await verifyWeComBot(credentials, { dial: wecom.dial }), String(errcode)).toMatchObject({
        ok: false,
        status: 400,
        code: 'WECOM_CREDENTIALS_INVALID'
      })
      expect(wecom.closes()).toBe(1)
    }
    expect(await verifyWeComBot(credentials, { dial: fakeWeCom(reply(846601)).dial })).toMatchObject({
      ok: false,
      status: 400,
      code: 'WECOM_LONG_CONNECTION_DISABLED'
    })
    for (const errcode of [-1, 45009, 45033]) {
      const wecom = fakeWeCom(reply(errcode))
      expect(await verifyWeComBot(credentials, { dial: wecom.dial }), String(errcode)).toMatchObject({
        ok: false,
        status: 503,
        code: 'WECOM_CHECK_UNAVAILABLE'
      })
    }
  })

  it('answers unavailable when the socket fails, closes early, or never dials', async () => {
    const failing = [fakeWeCom((_frame, h) => h.error()), fakeWeCom((_frame, h) => h.closed())]
    for (const wecom of failing) {
      expect(await verifyWeComBot(credentials, { dial: wecom.dial })).toMatchObject({
        status: 503,
        code: 'WECOM_CHECK_UNAVAILABLE'
      })
      expect(wecom.closes()).toBe(1)
    }
    const throwing: WeComDial = () => {
      throw new Error('bad url')
    }
    expect(await verifyWeComBot(credentials, { dial: throwing })).toMatchObject({ status: 503 })
  })

  it('gives up at the deadline and closes the socket', async () => {
    vi.useFakeTimers()
    try {
      const wecom = fakeWeCom(() => {})
      const pending = verifyWeComBot(credentials, { dial: wecom.dial })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await pending).toMatchObject({ status: 503, code: 'WECOM_CHECK_UNAVAILABLE' })
      expect(wecom.closes()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never puts the Secret in a refusal', async () => {
    const result = await verifyWeComBot(credentials, { dial: fakeWeCom(reply(853000)).dial })
    expect(JSON.stringify(result)).not.toContain('secret-placeholder')
  })
})

describe('WeCom provider validation', () => {
  it('validates through the injected dial', async () => {
    const wecom = fakeWeCom(reply(0, 'ok'))
    const provider = createWeComCpProvider({ dial: wecom.dial, isInstalled: async () => false })
    expect((await provider.validateConfig(credentials, 'socket')).ok).toBe(true)
    expect(wecom.sent).toHaveLength(1)
  })

  it('refuses an installed BotID without dialing, so the live connection is not evicted', async () => {
    const wecom = fakeWeCom(reply(0, 'ok'))
    const isInstalled = vi.fn(async (botId: string) => botId === 'aibot-example')
    const provider = createWeComCpProvider({ dial: wecom.dial, isInstalled })
    expect(await provider.validateConfig(credentials, 'socket')).toMatchObject({
      ok: false,
      status: 409,
      code: 'WECOM_BOT_ALREADY_INSTALLED',
      message: 'This WeCom bot is already installed. Reuse the existing bot.'
    })
    expect(isInstalled).toHaveBeenCalledWith('aibot-example')
    expect(wecom.urls).toEqual([])
  })
})

describe('WeCom installation', () => {
  it('packs the secret slots as DingTalk does and fences one bot per BotID', () => {
    const install = createWeComCpProvider().buildNewBotInstall({
      credentials,
      identity: {},
      transport: 'socket',
      shareable: false
    })
    expect(install.secrets).toEqual({ botToken: 'secret-placeholder', appToken: 'aibot-example', signingSecret: null })
    expect(install.bot).toEqual({ externalAppId: 'aibot-example' })
    expect(install.externalIdentity).toEqual({
      externalAppId: 'aibot-example',
      externalTenantId: '-',
      conflictMessage: 'This WeCom bot is already installed. Reuse the existing bot.'
    })
  })

  it('has no relay path and stores the BotID under the tenantless sentinel', () => {
    const provider = createWeComCpProvider()
    expect(provider.projectBotAssign).toBeUndefined()
    expect(provider.secretShape.httpAssignRequires).toEqual([])
    expect(provider.installRoutes('public-callback')).toEqual([])
    expect(provider.projectBotIdentity?.({ externalAppId: 'aibot-example' } as never)).toEqual({
      externalAppId: 'aibot-example',
      externalTenantId: '-'
    })
    expect(provider.projectBotIdentity?.({} as never)).toEqual({})
  })

  it('projects the integration config the daemon reads', async () => {
    const config = await createWeComCpProvider().projectIntegrationConfig(
      {} as IntegrationRecord,
      { externalAppId: 'aibot-example' } as BotRecord,
      {} as IntegrationCoreEnvelope,
      { botToken: 'secret-placeholder', appToken: 'aibot-example', signingSecret: null }
    )
    expect(IntegrationWeComConfig.parse(config)).toEqual({ botId: 'aibot-example', secret: 'secret-placeholder' })
  })

  it('exposes the credential block through the actual create schema', () => {
    const schema = buildCreateIntegrationBody(buildCpPlatformRegistry([createWeComCpProvider()]))
    const agentId = '00000000-0000-4000-8000-000000000001'
    expect(schema.safeParse({ platform: 'wecom', agentId, wecom: credentials }).success).toBe(true)
    expect(
      schema.safeParse({ platform: 'wecom', agentId, wecom: { ...credentials, botId: 'two words' } }).success
    ).toBe(false)
    expect(
      schema.safeParse({ platform: 'wecom', agentId, wecom: { botId: 'aibot-example', secret: ' ' } }).success
    ).toBe(false)
  })
})
