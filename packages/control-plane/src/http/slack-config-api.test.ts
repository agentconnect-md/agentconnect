import { describe, it, expect, vi, afterEach } from 'vitest'
import { slackConfigApi } from './slack-config-api.js'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

function mockFetch(impl: () => Response): void {
  globalThis.fetch = vi.fn(async () => impl()) as unknown as typeof fetch
}

describe('slackConfigApi.createApp (apps.manifest.create)', () => {
  it('maps a successful response to the app id + credentials + authorize url', async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            ok: true,
            app_id: 'A012ABCD0A0',
            credentials: { client_id: 'cid', client_secret: 'csecret', signing_secret: 'ssecret' },
            oauth_authorize_url: 'https://slack.com/oauth/v2/authorize?client_id=cid&scope=chat:write'
          }),
          { status: 200 }
        )
    )
    const res = await slackConfigApi.createApp('xoxe.xoxp-token', { display_information: { name: 'x' } })
    expect(res).toEqual({
      ok: true,
      app: {
        appId: 'A012ABCD0A0',
        clientId: 'cid',
        clientSecret: 'csecret',
        signingSecret: 'ssecret',
        oauthAuthorizeUrl: 'https://slack.com/oauth/v2/authorize?client_id=cid&scope=chat:write'
      }
    })
  })

  it('surfaces the Slack error string when ok:false (e.g. bad/expired config token)', async () => {
    mockFetch(() => new Response(JSON.stringify({ ok: false, error: 'token_expired' }), { status: 200 }))
    expect(await slackConfigApi.createApp('xoxe.xoxp-bad', {})).toEqual({ ok: false, error: 'token_expired' })
  })

  it('reports unreachable on a non-2xx HTTP response', async () => {
    mockFetch(() => new Response('nope', { status: 500 }))
    expect(await slackConfigApi.createApp('t', {})).toEqual({ ok: false, error: 'unreachable' })
  })

  it('reports unreachable (never throws) on a network failure', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('down')
    }) as unknown as typeof fetch
    expect(await slackConfigApi.createApp('t', {})).toEqual({ ok: false, error: 'unreachable' })
  })

  it('reports malformed_response when a required field is missing', async () => {
    mockFetch(() => new Response(JSON.stringify({ ok: true, app_id: 'A1' }), { status: 200 })) // no credentials
    expect(await slackConfigApi.createApp('t', {})).toEqual({ ok: false, error: 'malformed_response' })
  })
})

describe('slackConfigApi.exportApp (apps.manifest.export)', () => {
  it('returns the complete exported manifest and sends the target app id', async () => {
    const manifest = { display_information: { name: 'acme' }, custom: { keep: true } }
    mockFetch(() => new Response(JSON.stringify({ ok: true, manifest }), { status: 200 }))

    expect(await slackConfigApi.exportApp('xoxe.xoxp-token', 'A012ABCD0A0')).toEqual({ ok: true, manifest })
    const request = vi.mocked(globalThis.fetch).mock.calls[0]!
    expect(request[0]).toBe('https://slack.com/api/apps.manifest.export')
    const body = new URLSearchParams(String(request[1]?.body))
    expect(body.get('token')).toBe('xoxe.xoxp-token')
    expect(body.get('app_id')).toBe('A012ABCD0A0')
  })

  it('surfaces Slack errors and malformed success responses', async () => {
    mockFetch(() => new Response(JSON.stringify({ ok: false, error: 'no_permission' }), { status: 200 }))
    expect(await slackConfigApi.exportApp('t', 'A1')).toEqual({ ok: false, error: 'no_permission' })

    mockFetch(() => new Response(JSON.stringify({ ok: true, manifest: null }), { status: 200 }))
    expect(await slackConfigApi.exportApp('t', 'A1')).toEqual({ ok: false, error: 'malformed_response' })
  })
})

describe('slackConfigApi.updateApp (apps.manifest.update)', () => {
  it('returns permissions_updated and submits the complete manifest', async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ ok: true, app_id: 'A012ABCD0A0', permissions_updated: true }), {
          status: 200
        })
    )
    const manifest = { display_information: { name: 'acme' }, custom: { keep: true } }

    expect(await slackConfigApi.updateApp('xoxe.xoxp-token', 'A012ABCD0A0', manifest)).toEqual({
      ok: true,
      permissionsUpdated: true
    })
    const request = vi.mocked(globalThis.fetch).mock.calls[0]!
    expect(request[0]).toBe('https://slack.com/api/apps.manifest.update')
    const body = new URLSearchParams(String(request[1]?.body))
    expect(body.get('app_id')).toBe('A012ABCD0A0')
    expect(JSON.parse(body.get('manifest')!)).toEqual(manifest)
  })

  it('surfaces Slack errors and malformed success responses', async () => {
    mockFetch(() => new Response(JSON.stringify({ ok: false, error: 'app_not_owned_by_manager_app' }), { status: 200 }))
    expect(await slackConfigApi.updateApp('t', 'A1', {})).toEqual({
      ok: false,
      error: 'app_not_owned_by_manager_app'
    })

    mockFetch(() => new Response(JSON.stringify({ ok: true, app_id: 'A1' }), { status: 200 }))
    expect(await slackConfigApi.updateApp('t', 'A1', {})).toEqual({ ok: false, error: 'malformed_response' })
  })
})

describe('slackConfigApi.exchangeOAuth (oauth.v2.access)', () => {
  it('maps a successful exchange to the bot token + app/team facts', async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            ok: true,
            access_token: 'xoxb-123',
            token_type: 'bot',
            app_id: 'A123456789',
            bot_user_id: 'U123456789',
            team: { id: 'T1', name: 'Acme' }
          }),
          { status: 200 }
        )
    )
    const res = await slackConfigApi.exchangeOAuth({
      clientId: 'cid',
      clientSecret: 'csecret',
      code: 'the-code',
      redirectUri: 'https://cp.example/api/v1/integrations/slack/oauth/callback'
    })
    expect(res).toEqual({
      ok: true,
      result: { botToken: 'xoxb-123', appId: 'A123456789', teamId: 'T1', teamName: 'Acme', botUserId: 'U123456789' }
    })
  })

  it('surfaces the Slack error string when ok:false (e.g. invalid_code)', async () => {
    mockFetch(() => new Response(JSON.stringify({ ok: false, error: 'invalid_code' }), { status: 200 }))
    const res = await slackConfigApi.exchangeOAuth({ clientId: 'c', clientSecret: 's', code: 'x', redirectUri: 'u' })
    expect(res).toEqual({ ok: false, error: 'invalid_code' })
  })

  it('reports unreachable (never throws) on a network failure', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('down')
    }) as unknown as typeof fetch
    const res = await slackConfigApi.exchangeOAuth({ clientId: 'c', clientSecret: 's', code: 'x', redirectUri: 'u' })
    expect(res).toEqual({ ok: false, error: 'unreachable' })
  })
})

describe('slackConfigApi.rotateConfigToken (tooling.tokens.rotate)', () => {
  it('maps a rotate to the fresh pair + expiry (exp is unix seconds)', async () => {
    const exp = 1_700_000_000 // seconds
    mockFetch(
      () =>
        new Response(JSON.stringify({ ok: true, token: 'xoxe.xoxp-new', refresh_token: 'xoxe-new', exp }), {
          status: 200
        })
    )
    const res = await slackConfigApi.rotateConfigToken('xoxe-old')
    expect(res).toEqual({
      ok: true,
      rotated: { accessToken: 'xoxe.xoxp-new', refreshToken: 'xoxe-new', accessExpiresAt: new Date(exp * 1000) }
    })
  })

  it('surfaces the Slack error string when ok:false (e.g. spent/invalid refresh token)', async () => {
    mockFetch(() => new Response(JSON.stringify({ ok: false, error: 'invalid_refresh_token' }), { status: 200 }))
    expect(await slackConfigApi.rotateConfigToken('bad')).toEqual({ ok: false, error: 'invalid_refresh_token' })
  })

  it('reports malformed_response when a required field is missing', async () => {
    mockFetch(() => new Response(JSON.stringify({ ok: true, token: 'xoxe.xoxp-new' }), { status: 200 })) // no refresh/exp
    expect(await slackConfigApi.rotateConfigToken('r')).toEqual({ ok: false, error: 'malformed_response' })
  })

  it('reports unreachable (never throws) on a network failure', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('down')
    }) as unknown as typeof fetch
    expect(await slackConfigApi.rotateConfigToken('r')).toEqual({ ok: false, error: 'unreachable' })
  })
})
