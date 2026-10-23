import { describe, expect, it } from 'vitest'
import { DINGTALK_ORIGINS, DingTalkApi, DingTalkApiError } from '../src/platforms/dingtalk/api.js'

const credentials = { clientId: 'client-id-example', clientSecret: 'secret' }

// Each edition's API host accepts only its own apps, as DingTalk answers a foreign app's credentials.
function editions(home: 'mainland' | 'international' | 'none') {
  const urls: string[] = []
  const fetchImpl = (async (url: string | URL | Request) => {
    urls.push(String(url))
    const origin = Object.entries(DINGTALK_ORIGINS).find(([, o]) => String(url).startsWith(o.api))?.[0]
    if (String(url).endsWith('/v1.0/oauth2/accessToken'))
      return origin === home
        ? Response.json({ accessToken: `token-${home}`, expireIn: 7200 })
        : Response.json({ code: 'invalidClientIdOrSecret', message: 'invalid' }, { status: 400 })
    if (String(url).endsWith('/v1.0/gateway/connections/open'))
      return Response.json({ endpoint: 'wss://stream.example.test', ticket: 'ticket-1' })
    return Response.json({})
  }) as typeof fetch
  return { urls, api: new DingTalkApi(credentials, { fetchImpl }) }
}

describe('DingTalk edition', () => {
  it('stays on the mainland hosts for a mainland app', async () => {
    const { urls, api } = editions('mainland')
    expect(await api.accessToken()).toBe('token-mainland')
    expect(api.edition).toBe('mainland')
    expect(urls).toEqual([`${DINGTALK_ORIGINS.mainland.api}/v1.0/oauth2/accessToken`])
  })

  it('moves to the international hosts when the mainland refuses the credentials', async () => {
    const { urls, api } = editions('international')
    expect(await api.accessToken()).toBe('token-international')
    expect(api.edition).toBe('international')
    expect([api.origin, api.oapiOrigin]).toEqual([
      DINGTALK_ORIGINS.international.api,
      DINGTALK_ORIGINS.international.oapi
    ])
    await api.openStream()
    expect(urls.at(-1)).toBe(`${DINGTALK_ORIGINS.international.api}/v1.0/gateway/connections/open`)
  })

  it('finds the edition before opening the Stream', async () => {
    const { urls, api } = editions('international')
    await api.openStream()
    expect(urls.map((url) => new URL(url).origin)).toEqual([
      DINGTALK_ORIGINS.mainland.api,
      DINGTALK_ORIGINS.international.api,
      DINGTALK_ORIGINS.international.api
    ])
  })

  it('reports credentials neither edition accepts', async () => {
    const { api } = editions('none')
    const error = await api.accessToken().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DingTalkApiError)
    expect((error as DingTalkApiError).code).toBe('invalidClientIdOrSecret')
    expect(api.edition).toBe('mainland')
  })
})
