import { describe, expect, it } from 'vitest'
import type { FastifyPluginAsync } from 'fastify'
import type { BotRecord, IntegrationRecord } from '../../persistence/ports.js'
import type { IntegrationCoreEnvelope } from '@agentconnect.md/protocol'
import { createWeChatCpProvider, weChatBotIdentity } from './provider.js'

const bot = (platformConfig: Record<string, string> | null) => ({ platformConfig }) as unknown as BotRecord
const integration = {} as IntegrationRecord
const core = {} as IntegrationCoreEnvelope
const secrets = { botToken: 'example-token', appToken: 'abc@im.bot', signingSecret: null }
const route: FastifyPluginAsync = async () => {}

describe('WeChat Control Plane provider', () => {
  it('serves its login routes at the organization scope', () => {
    expect(createWeChatCpProvider({ routes: [route] }).installRoutes('org')).toEqual([route])
    expect(createWeChatCpProvider({ routes: [route] }).installRoutes('public-callback')).toEqual([])
  })

  it('projects the token, the iLink bot id and the bound WeChat user', async () => {
    const provider = createWeChatCpProvider({})
    await expect(
      provider.projectIntegrationConfig(integration, bot({ wechatUserId: 'u@im.wechat' }), core, secrets)
    ).resolves.toEqual({ botId: 'abc@im.bot', botToken: 'example-token', boundUserId: 'u@im.wechat' })
    await expect(
      provider.projectIntegrationConfig(
        integration,
        bot({ wechatUserId: 'u@im.wechat', wechatApiUrl: 'https://sz.ilinkai.weixin.qq.com' }),
        core,
        secrets
      )
    ).resolves.toMatchObject({ apiUrl: 'https://sz.ilinkai.weixin.qq.com' })
  })

  it('withholds the payload when the binding is incomplete', async () => {
    const provider = createWeChatCpProvider({})
    await expect(provider.projectIntegrationConfig(integration, bot(null), core, secrets)).resolves.toBeUndefined()
    await expect(
      provider.projectIntegrationConfig(integration, bot({ wechatUserId: 'u@im.wechat' }), core, {
        ...secrets,
        appToken: null
      })
    ).resolves.toBeUndefined()
  })

  it('refuses pasted credentials and frees no bot for reuse', async () => {
    const provider = createWeChatCpProvider({})
    await expect(provider.validateConfig({}, 'socket')).resolves.toMatchObject({
      ok: false,
      status: 400,
      code: 'WECHAT_QR_LOGIN_REQUIRED'
    })
    expect(provider.releasesFreedBot?.(bot(null))).toBe(true)
  })

  it('keeps only an https base URL from the login', () => {
    const login = {
      ilinkBotId: 'abc@im.bot',
      ilinkUserId: 'u@im.wechat',
      createdByUserId: 'member-1',
      baseUrl: 'http://example.test'
    } as Parameters<typeof weChatBotIdentity>[0]
    expect(weChatBotIdentity(login)).toEqual({
      wechatBotId: 'abc@im.bot',
      wechatUserId: 'u@im.wechat',
      boundMemberUserId: 'member-1'
    })
  })
})
