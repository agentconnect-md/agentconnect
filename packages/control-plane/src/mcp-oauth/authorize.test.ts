import { describe, it, expect } from 'vitest'
import { buildAuthorizeUrl, issuerResponseValid, pkceChallenge, pkcePair } from './authorize.js'
import { exchangeCode, refreshGrant, type TokenClient } from './token-endpoint.js'
import type { AuthServerMetadata, Dial } from './discovery.js'
import type { GuardedResult } from '../net/guarded-fetch.js'

const ISSUER = 'https://auth.example.test'
const AS: AuthServerMetadata = {
  issuer: ISSUER,
  authorizationEndpoint: `${ISSUER}/authorize`,
  tokenEndpoint: `${ISSUER}/token`,
  issParameterSupported: true,
  clientIdMetadataDocumentSupported: false
}
const CLIENT: TokenClient = {
  tokenEndpoint: `${ISSUER}/token`,
  clientId: 'client-1',
  resource: 'https://mcp.example.test/mcp/'
}
const NOW = new Date('2026-09-14T12:00:00Z').getTime()

const response = (json: unknown, status = 200): GuardedResult => ({
  ok: true,
  response: { status, headers: {}, text: JSON.stringify(json), json }
})

function recordingDial(result: GuardedResult) {
  const seen: Array<{ url: string; headers?: Record<string, string>; body?: string }> = []
  const dial = (async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    seen.push({ url, ...(init?.headers ? { headers: init.headers } : {}), ...(init?.body ? { body: init.body } : {}) })
    return result
  }) as Dial
  return { dial, seen }
}

describe('pkcePair', () => {
  it('produces a fresh S256 pair whose challenge is derivable from the verifier alone', () => {
    const a = pkcePair()
    const b = pkcePair()
    expect(a.verifier).not.toBe(b.verifier)
    expect(pkceChallenge(a.verifier)).toBe(a.challenge)
    expect(a.challenge).not.toContain('=')
  })
})

describe('buildAuthorizeUrl', () => {
  it('carries PKCE S256, the state, and the RFC 8707 resource', () => {
    const url = new URL(
      buildAuthorizeUrl({
        metadata: AS,
        clientId: 'client-1',
        redirectUri: 'https://console.example.test/v1/mcp-providers/oauth/callback',
        state: 'nonce-1',
        codeChallenge: 'challenge-1',
        scopes: ['files:read', 'files:write'],
        resource: 'https://mcp.example.test/mcp'
      })
    )
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'client-1',
      redirect_uri: 'https://console.example.test/v1/mcp-providers/oauth/callback',
      state: 'nonce-1',
      code_challenge: 'challenge-1',
      code_challenge_method: 'S256',
      resource: 'https://mcp.example.test/mcp',
      scope: 'files:read files:write'
    })
  })

  it('omits scope entirely when none is known, rather than sending an empty one', () => {
    const url = new URL(
      buildAuthorizeUrl({
        metadata: AS,
        clientId: 'c',
        redirectUri: 'https://console.example.test/cb',
        state: 's',
        codeChallenge: 'c1',
        scopes: [],
        resource: 'https://mcp.example.test/mcp'
      })
    )
    expect(url.searchParams.has('scope')).toBe(false)
  })

  it('keeps query already present on the authorization endpoint', () => {
    const url = new URL(
      buildAuthorizeUrl({
        metadata: { ...AS, authorizationEndpoint: `${ISSUER}/authorize?tenant=acme` },
        clientId: 'c',
        redirectUri: 'https://console.example.test/cb',
        state: 's',
        codeChallenge: 'c1',
        scopes: [],
        resource: 'https://mcp.example.test/mcp'
      })
    )
    expect(url.searchParams.get('tenant')).toBe('acme')
  })
})

describe('issuerResponseValid — RFC 9207 §2.4', () => {
  it.each([
    ['advertised + present + matching', true, ISSUER, true],
    ['advertised + present + different', true, 'https://evil.example.test', false],
    ['advertised + absent', true, undefined, false],
    ['not advertised + present + matching', false, ISSUER, true],
    ['not advertised + present + different', false, 'https://evil.example.test', false],
    ['not advertised + absent', false, undefined, true]
  ])('%s', (_name, advertised, present, expected) => {
    expect(issuerResponseValid({ advertised, present, expected: ISSUER })).toBe(expected)
  })

  it('compares byte-for-byte, with no normalization of case, slash or port', () => {
    for (const present of [`${ISSUER}/`, 'https://AUTH.EXAMPLE.TEST', `${ISSUER}:443`]) {
      expect(issuerResponseValid({ advertised: true, present, expected: ISSUER })).toBe(false)
    }
  })
})

describe('token endpoint', () => {
  it('redeems a code with the verifier, the redirect and the resource', async () => {
    const { dial, seen } = recordingDial(
      response({ access_token: 'a1', refresh_token: 'r1', expires_in: 3600, scope: 'files:read' })
    )
    const result = await exchangeCode(
      dial,
      CLIENT,
      { code: 'code-1', redirectUri: 'https://console.example.test/cb', codeVerifier: 'verifier-1' },
      NOW
    )
    expect(result).toEqual({
      ok: true,
      grant: { accessToken: 'a1', refreshToken: 'r1', expiresAt: new Date(NOW + 3600_000), scope: 'files:read' }
    })
    expect(Object.fromEntries(new URLSearchParams(seen[0]!.body!))).toEqual({
      grant_type: 'authorization_code',
      code: 'code-1',
      redirect_uri: 'https://console.example.test/cb',
      code_verifier: 'verifier-1',
      client_id: 'client-1',
      // The published audience, trailing slash and all — never re-canonicalized.
      resource: 'https://mcp.example.test/mcp/'
    })
  })

  it('sends a confidential client as HTTP Basic and a public one with no authorization', async () => {
    const withSecret = recordingDial(response({ access_token: 'a1' }))
    await refreshGrant(withSecret.dial, { ...CLIENT, clientSecret: 's3cret' }, 'r1', NOW)
    expect(withSecret.seen[0]?.headers?.authorization).toBe(
      `Basic ${Buffer.from('client-1:s3cret').toString('base64')}`
    )
    const withoutSecret = recordingDial(response({ access_token: 'a1' }))
    await refreshGrant(withoutSecret.dial, CLIENT, 'r1', NOW)
    expect(withoutSecret.seen[0]?.headers?.authorization).toBeUndefined()
  })

  it('renews with the refresh grant and carries the resource there too', async () => {
    const { dial, seen } = recordingDial(response({ access_token: 'a2', expires_in: 600 }))
    const result = await refreshGrant(dial, CLIENT, 'r1', NOW)
    expect(result).toEqual({ ok: true, grant: { accessToken: 'a2', expiresAt: new Date(NOW + 600_000) } })
    expect(Object.fromEntries(new URLSearchParams(seen[0]!.body!))).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'r1',
      resource: 'https://mcp.example.test/mcp/'
    })
  })

  it('reports no expiry when the server advertises none', async () => {
    const { dial } = recordingDial(response({ access_token: 'a2' }))
    expect(await refreshGrant(dial, CLIENT, 'r1', NOW)).toEqual({
      ok: true,
      grant: { accessToken: 'a2', expiresAt: null }
    })
  })

  it.each([
    [response({ error: 'invalid_grant' }, 400), 'rejected'],
    [response({ error: 'invalid_client' }, 401), 'rejected'],
    [response({ error: 'server_error' }, 500), 'unreachable'],
    [response({ error: 'bad_gateway' }, 502), 'unreachable'],
    [response({ no_token: true }, 200), 'malformed'],
    [{ ok: false, failure: 'unreachable' } as GuardedResult, 'unreachable'],
    [{ ok: false, failure: 'address_blocked' } as GuardedResult, 'unreachable'],
    [{ ok: false, failure: 'malformed_response' } as GuardedResult, 'malformed']
  ])('separates a definitive refusal from learning nothing (%#)', async (result, failure) => {
    const { dial } = recordingDial(result)
    expect(await refreshGrant(dial, CLIENT, 'r1', NOW)).toEqual({ ok: false, failure })
  })
})
