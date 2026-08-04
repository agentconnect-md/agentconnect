import { describe, it, expect, vi, afterEach } from 'vitest'
import { verifySlackBot, verifySlackAppToken } from './slack-identity.js'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

function mockFetch(impl: () => Response): void {
  globalThis.fetch = vi.fn(async () => impl()) as unknown as typeof fetch
}

describe('verifySlackBot (auth.test)', () => {
  it('returns ok + the bot user name on a successful auth.test', async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            ok: true,
            user: 'matrix_test',
            user_id: 'U0123BOT',
            team: 'Acme',
            team_id: 'T0123',
            app_id: 'A0123'
          }),
          {
            status: 200,
            headers: { 'x-oauth-scopes': 'chat:write, channels:read, assistant:write' }
          }
        )
    )
    expect(await verifySlackBot('xoxb-good')).toEqual({
      status: 'ok',
      name: 'matrix_test',
      appId: 'A0123',
      botUserId: 'U0123BOT',
      teamId: 'T0123',
      teamName: 'Acme',
      scopes: ['chat:write', 'channels:read', 'assistant:write']
    })
  })

  it('falls back to the workspace name when the bot user is absent', async () => {
    mockFetch(() => new Response(JSON.stringify({ ok: true, team: 'Acme' }), { status: 200 }))
    expect(await verifySlackBot('xoxb-good')).toEqual({
      status: 'ok',
      name: 'Acme',
      appId: null,
      botUserId: null,
      teamId: null,
      teamName: 'Acme',
      scopes: null
    })
  })

  it('resolves the app id through bots.info when auth.test only returns a bot id', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, user: 'matrix_test', bot_id: 'B0123' })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, bot: { id: 'B0123', app_id: 'A0123' } }))
      ) as unknown as typeof fetch

    expect(await verifySlackBot('xoxb-good')).toEqual({
      status: 'ok',
      name: 'matrix_test',
      appId: 'A0123',
      botUserId: null,
      teamId: null,
      teamName: null,
      scopes: null
    })
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      'https://slack.com/api/bots.info',
      expect.objectContaining({ body: new URLSearchParams({ bot: 'B0123' }) })
    )
  })

  it('is ok with a null name when Slack returns neither user nor team', async () => {
    mockFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    expect(await verifySlackBot('xoxb-good')).toEqual({
      status: 'ok',
      name: null,
      appId: null,
      botUserId: null,
      teamId: null,
      teamName: null,
      scopes: null
    })
  })

  it('reports invalid when auth.test replies ok:false (bad/expired/revoked token)', async () => {
    mockFetch(() => new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), { status: 200 }))
    expect(await verifySlackBot('xoxb-bad')).toEqual({ status: 'invalid' })
  })

  it.each(['ratelimited', 'internal_error', 'service_unavailable', 'team_added_to_org'])(
    'reports unreachable when auth.test returns the transient %s error',
    async (error) => {
      mockFetch(() => new Response(JSON.stringify({ ok: false, error }), { status: 200 }))
      expect(await verifySlackBot('xoxb-good')).toEqual({ status: 'unreachable' })
    }
  )

  it('reports unreachable (never invalid) on a non-2xx HTTP response', async () => {
    mockFetch(() => new Response('nope', { status: 500 }))
    expect(await verifySlackBot('xoxb-x')).toEqual({ status: 'unreachable' })
  })

  it('reports unreachable (never throws) on a network failure', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    expect(await verifySlackBot('xoxb-x')).toEqual({ status: 'unreachable' })
  })
})

describe('verifySlackAppToken (apps.connections.open)', () => {
  it("returns 'ok' when Slack opens a Socket Mode URL", async () => {
    mockFetch(() => new Response(JSON.stringify({ ok: true, url: 'wss://example' }), { status: 200 }))
    expect(await verifySlackAppToken('xapp-good')).toBe('ok')
  })

  it("returns 'invalid' when Slack replies ok:false (bad token / missing connections:write)", async () => {
    mockFetch(() => new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), { status: 200 }))
    expect(await verifySlackAppToken('xapp-bad')).toBe('invalid')
  })

  it("returns 'unreachable' on a non-2xx HTTP response", async () => {
    mockFetch(() => new Response('nope', { status: 502 }))
    expect(await verifySlackAppToken('xapp-x')).toBe('unreachable')
  })

  it("returns 'unreachable' (never throws) on a network failure", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    expect(await verifySlackAppToken('xapp-x')).toBe('unreachable')
  })
})
