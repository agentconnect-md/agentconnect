import { describe, expect, it } from 'vitest'
import {
  DingTalkApi,
  DingTalkApiError,
  dingTalkApiError,
  DingTalkLimitError,
  dingTalkLimitOf
} from '../src/platforms/dingtalk/api.js'

const ORIGIN = 'https://api.example.test'

function apiAnswering(status: number, body: unknown) {
  const calls: { path: string; method?: string; headers: Record<string, string> }[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).slice(ORIGIN.length)
    calls.push({
      path,
      ...(init?.method ? { method: init.method } : {}),
      headers: init?.headers as Record<string, string>
    })
    if (path === '/v1.0/oauth2/accessToken')
      return new Response(JSON.stringify({ accessToken: 'token-1', expireIn: 7200 }), { status: 200 })
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
  return {
    calls,
    api: new DingTalkApi({ clientId: 'client-id-example', clientSecret: 'secret' }, { fetchImpl, origin: ORIGIN })
  }
}

async function refusal(status: number, body: unknown): Promise<unknown> {
  const { api } = apiAnswering(status, body)
  return await api.call('PUT', '/v1.0/card/streaming', {}).then(
    () => undefined,
    (error: unknown) => error
  )
}

describe('DingTalk limit errors', () => {
  it('maps the monthly quota codes to a quota limit', async () => {
    const error = await refusal(403, { code: 'Forbidden.AccessDenied.ApiCountLimitForOrg', message: 'over' })
    expect(error).toBeInstanceOf(DingTalkLimitError)
    expect(dingTalkLimitOf(error)).toBe('quota')
    expect(dingTalkLimitOf(await refusal(200, { errcode: 90020, errmsg: 'over' }))).toBe('quota')
  })

  it('maps the per-app QPS codes to a rate limit', async () => {
    expect(
      dingTalkLimitOf(await refusal(403, { code: 'Forbidden.AccessDenied.QpsLimitForAppkeyAndApi', message: 'slow' }))
    ).toBe('rate')
    expect(dingTalkLimitOf(await refusal(200, { errcode: 90018, errmsg: 'slow' }))).toBe('rate')
    expect(dingTalkLimitOf(dingTalkApiError('/x', 403, '90018'))).toBe('rate')
  })

  it('leaves any other refusal an ordinary API error', async () => {
    const error = await refusal(403, { code: 'Forbidden.AccessDenied.AccessTokenPermissionDenied', message: 'no' })
    expect(error).toBeInstanceOf(DingTalkApiError)
    expect(error).not.toBeInstanceOf(DingTalkLimitError)
    expect(dingTalkLimitOf(error)).toBeUndefined()
    expect(dingTalkLimitOf(new Error('network'))).toBeUndefined()
  })

  it('sends a card call with the access token and its method', async () => {
    const { api, calls } = apiAnswering(200, { success: true })
    await expect(api.call('PUT', '/v1.0/card/instances', { outTrackId: 'track-1' })).resolves.toEqual({
      success: true
    })
    expect(calls.at(-1)).toMatchObject({
      path: '/v1.0/card/instances',
      method: 'PUT',
      headers: { 'x-acs-dingtalk-access-token': 'token-1' }
    })
  })
})
