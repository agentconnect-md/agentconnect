import { describe, expect, it } from 'vitest'
import { DINGTALK_ORIGINS, DingTalkApi } from '../src/platforms/dingtalk/api.js'
import { DingTalkConnection } from '../src/platforms/dingtalk/connection.js'

const log = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

// Records each request's URL and answers the token and Stream calls.
function recording() {
  const urls: string[] = []
  const fetchImpl = (async (url: string | URL | Request) => {
    urls.push(String(url))
    if (String(url).endsWith('/v1.0/oauth2/accessToken'))
      return Response.json({ accessToken: 'token-1', expireIn: 7200 })
    return Response.json({ endpoint: 'wss://stream.example.test', ticket: 'ticket-1' })
  }) as typeof fetch
  return { urls, fetchImpl }
}

describe('DingTalk edition', () => {
  it('calls the mainland hosts when no edition is configured', async () => {
    const { urls, fetchImpl } = recording()
    const api = new DingTalkApi({ clientId: 'client-id-example', clientSecret: 'secret' }, { fetchImpl })
    await api.openStream()
    expect(api.oapiOrigin).toBe(DINGTALK_ORIGINS.mainland.oapi)
    expect(urls).toEqual([`${DINGTALK_ORIGINS.mainland.api}/v1.0/gateway/connections/open`])
  })

  it('calls only the international hosts for an international app', async () => {
    const { urls, fetchImpl } = recording()
    const api = new DingTalkApi(
      { clientId: 'client-id-example', clientSecret: 'secret', edition: 'international' },
      { fetchImpl }
    )
    await api.accessToken()
    await api.openStream()
    expect(api.oapiOrigin).toBe(DINGTALK_ORIGINS.international.oapi)
    expect(urls.map((url) => new URL(url).origin)).toEqual([
      DINGTALK_ORIGINS.international.api,
      DINGTALK_ORIGINS.international.api
    ])
  })

  it('sends an international app no question cards', () => {
    const group = (edition: 'mainland' | 'international') => ({
      clientId: 'client-id-example',
      clientSecret: 'secret',
      edition,
      integrations: []
    })
    const deps = { log, onMessage: () => {}, questionTemplate: 'template.schema' }
    expect(new DingTalkConnection(group('mainland'), deps).cards).toBeDefined()
    expect(new DingTalkConnection(group('international'), deps).cards).toBeUndefined()
  })
})
