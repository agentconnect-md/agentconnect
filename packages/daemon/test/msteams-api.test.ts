import { describe, expect, it } from 'vitest'
import {
  MSTEAMS_MAX_RETRY_AFTER_MS,
  MSTEAMS_TOKEN_SCOPE,
  MsTeamsApi,
  MsTeamsApiError,
  msTeamsActivitiesUrl,
  msTeamsTokenEndpoint
} from '../src/platforms/msteams/api.js'

const ZERO = '00000000-0000-0000-0000-000000000000'
const SERVICE_URL = `https://smba.trafficmanager.net/amer/${ZERO}/`
const CHANNEL_THREAD = '19:example-channel@thread.tacv2;messageid=1700000000000'
const CREDENTIALS = { appId: ZERO, tenantId: ZERO, clientSecret: 'client-secret-example' }

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

type Answer = { status: number; body?: unknown; headers?: Record<string, string> }

/** A scripted `fetch`: the token endpoint answers from `tokens`, everything else from `answers` in order. */
function fakeFetch(
  answers: Answer[],
  tokens: Answer[] = [{ status: 200, body: { access_token: 'tok-1', expires_in: 3600 } }]
) {
  const calls: Call[] = []
  const respond = (a: Answer) =>
    ({
      ok: a.status >= 200 && a.status < 300,
      status: a.status,
      headers: { get: (name: string) => a.headers?.[name.toLowerCase()] ?? null },
      json: async () => a.body
    }) as unknown as Response
  const impl = (async (url: unknown, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(typeof init?.body === 'string' ? { body: init.body } : {})
    }
    calls.push(call)
    if (call.url === msTeamsTokenEndpoint(ZERO)) return respond(tokens.shift() ?? { status: 500 })
    const next = answers.shift()
    if (!next) throw new Error(`unexpected call ${call.method} ${call.url}`)
    return respond(next)
  }) as typeof fetch
  return { impl, calls }
}

function api(fetchImpl: typeof fetch, clock = { t: 1_000_000 }, sleeps: number[] = []) {
  return new MsTeamsApi(CREDENTIALS, {
    fetchImpl,
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    random: () => 0
  })
}

const target = { serviceUrl: SERVICE_URL, conversationId: CHANNEL_THREAD }

describe('msTeamsActivitiesUrl', () => {
  it('encodes the conversation ID under the recorded serviceUrl, with or without its trailing slash', () => {
    const encoded = encodeURIComponent(CHANNEL_THREAD)
    expect(msTeamsActivitiesUrl(SERVICE_URL, CHANNEL_THREAD)).toBe(
      `${SERVICE_URL}v3/conversations/${encoded}/activities`
    )
    expect(msTeamsActivitiesUrl(SERVICE_URL.slice(0, -1), CHANNEL_THREAD, '1700000000001')).toBe(
      `${SERVICE_URL}v3/conversations/${encoded}/activities/1700000000001`
    )
    expect(encoded).not.toContain(';')
  })

  it('refuses a serviceUrl that is not plain https', () => {
    expect(() => msTeamsActivitiesUrl('http://smba.trafficmanager.net/amer/', 'a:1')).toThrow(MsTeamsApiError)
    expect(() => msTeamsActivitiesUrl('https://user:pw@smba.trafficmanager.net/amer/', 'a:1')).toThrow(MsTeamsApiError)
  })
})

describe('MsTeamsApi', () => {
  it('requests a client-credentials token from the tenant endpoint and caches it until five minutes before expiry', async () => {
    const { impl, calls } = fakeFetch(
      [
        { status: 201, body: { id: 'act-1' } },
        { status: 201, body: { id: 'act-2' } },
        { status: 201, body: { id: 'act-3' } }
      ],
      [
        { status: 200, body: { access_token: 'tok-1', expires_in: 3600 } },
        { status: 200, body: { access_token: 'tok-2', expires_in: 3600 } }
      ]
    )
    const clock = { t: 1_000_000 }
    const client = api(impl, clock)
    expect(await client.postActivity(target, { type: 'message', text: 'one' })).toBe('act-1')
    clock.t += 54 * 60_000
    expect(await client.postActivity(target, { type: 'message', text: 'two' })).toBe('act-2')
    clock.t += 2 * 60_000
    expect(await client.postActivity(target, { type: 'message', text: 'three' })).toBe('act-3')

    const mints = calls.filter((c) => c.url === msTeamsTokenEndpoint(ZERO))
    expect(mints).toHaveLength(2)
    const form = new URLSearchParams(mints[0]!.body)
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'client_credentials',
      client_id: ZERO,
      client_secret: 'client-secret-example',
      scope: MSTEAMS_TOKEN_SCOPE
    })
    const sends = calls.filter((c) => c.url !== msTeamsTokenEndpoint(ZERO))
    expect(sends.map((c) => c.headers.authorization)).toEqual(['Bearer tok-1', 'Bearer tok-1', 'Bearer tok-2'])
  })

  it('shares one token request between concurrent calls', async () => {
    const { impl, calls } = fakeFetch([
      { status: 201, body: { id: 'act-1' } },
      { status: 201, body: { id: 'act-2' } }
    ])
    const client = api(impl)
    await Promise.all([client.postActivity(target, {}), client.postActivity(target, {})])
    expect(calls.filter((c) => c.url === msTeamsTokenEndpoint(ZERO))).toHaveLength(1)
  })

  it('names a rejected secret as a credential failure without echoing it', async () => {
    const { impl } = fakeFetch([], [{ status: 401, body: { error: 'invalid_client' } }])
    const err = await api(impl)
      .postActivity(target, {})
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MsTeamsApiError)
    expect((err as MsTeamsApiError).kind).toBe('credential_rejected')
    expect((err as MsTeamsApiError).permanent).toBe(true)
    expect(String((err as Error).message)).not.toContain('client-secret-example')
  })

  it('retries a 429 after the Retry-After it was given', async () => {
    const { impl, calls } = fakeFetch([
      { status: 429, headers: { 'retry-after': '3' } },
      { status: 412 },
      { status: 201, body: { id: 'act-1' } }
    ])
    const sleeps: number[] = []
    expect(await api(impl, { t: 1_000_000 }, sleeps).postActivity(target, { text: 'x' })).toBe('act-1')
    expect(sleeps).toEqual([3_000, 2_000])
    expect(calls.filter((c) => c.method === 'POST' && c.url.includes('/activities'))).toHaveLength(3)
  })

  it('waits out a Retry-After longer than its own backoff cap, and gives up on one beyond the honored bound', async () => {
    const long = fakeFetch([
      { status: 429, headers: { 'retry-after': '45' } },
      { status: 201, body: { id: 'act-2' } }
    ])
    const sleeps: number[] = []
    expect(await api(long.impl, { t: 1_000_000 }, sleeps).postActivity(target, { text: 'x' })).toBe('act-2')
    expect(sleeps).toEqual([45_000])

    const beyond = fakeFetch([{ status: 429, headers: { 'retry-after': `${MSTEAMS_MAX_RETRY_AFTER_MS / 1000 + 1}` } }])
    const tooLong: number[] = []
    const err = (await api(beyond.impl, { t: 1_000_000 }, tooLong)
      .postActivity(target, {})
      .catch((e: unknown) => e)) as MsTeamsApiError
    expect(err.kind).toBe('rate_limited')
    expect(tooLong).toEqual([])
    expect(beyond.calls.filter((c) => c.url.includes('/activities'))).toHaveLength(1)
  })

  it('retries a 502 on an edit but never re-sends a post that may have landed', async () => {
    const post = fakeFetch([{ status: 502 }])
    const err = await api(post.impl)
      .postActivity(target, {})
      .catch((e: unknown) => e)
    expect((err as MsTeamsApiError).kind).toBe('ambiguous')
    expect(post.calls.filter((c) => c.url.includes('/activities'))).toHaveLength(1)

    const put = fakeFetch([{ status: 504 }, { status: 200, body: {} }])
    await api(put.impl).updateActivity(target, '1700000000001', { type: 'message', text: 'edited' })
    const puts = put.calls.filter((c) => c.method === 'PUT')
    expect(puts).toHaveLength(2)
    expect(JSON.parse(puts[0]!.body!)).toEqual({ type: 'message', text: 'edited', id: '1700000000001' })
  })

  it('treats a bot not installed for the user and blocked writes as permanent, with no retry', async () => {
    const notInstalled = fakeFetch([
      {
        status: 403,
        body: { error: { code: 'BadArgument', message: "Bot is not installed in user's personal scope" } }
      }
    ])
    const a = (await api(notInstalled.impl)
      .postActivity({ serviceUrl: SERVICE_URL, conversationId: 'a:example-personal' }, {})
      .catch((e: unknown) => e)) as MsTeamsApiError
    expect(a.kind).toBe('not_installed')
    expect(a.permanent).toBe(true)

    const blocked = fakeFetch([{ status: 403, body: { error: { code: 'MessageWritesBlocked', message: 'blocked' } } }])
    const b = (await api(blocked.impl)
      .updateActivity(target, '1700000000001', {})
      .catch((e: unknown) => e)) as MsTeamsApiError
    expect(b.kind).toBe('writes_blocked')
    expect(b.permanent).toBe(true)
    expect(blocked.calls.filter((c) => c.method === 'PUT')).toHaveLength(1)
  })

  it('refreshes the token once on a 401 from the connector', async () => {
    const { impl, calls } = fakeFetch(
      [{ status: 401 }, { status: 201, body: { id: 'act-1' } }],
      [
        { status: 200, body: { access_token: 'tok-1', expires_in: 3600 } },
        { status: 200, body: { access_token: 'tok-2', expires_in: 3600 } }
      ]
    )
    expect(await api(impl).postActivity(target, {})).toBe('act-1')
    const sends = calls.filter((c) => c.url !== msTeamsTokenEndpoint(ZERO))
    expect(sends.map((c) => c.headers.authorization)).toEqual(['Bearer tok-1', 'Bearer tok-2'])
  })

  it('counts a delete of an activity already gone as deleted', async () => {
    const { impl } = fakeFetch([{ status: 404, body: { error: { code: 'NotFound' } } }])
    await expect(api(impl).deleteActivity(target, '1700000000001')).resolves.toBeUndefined()
  })
})
