import { describe, it, expect } from 'vitest'
import { clientSecretAuthFor, exchangeCode, refreshGrant, type TokenClient } from './token-endpoint.js'
import type { Dial } from './discovery.js'

const NOW = new Date('2026-09-14T12:00:00Z').getTime()
const ENDPOINT = 'https://auth.example.test/token'

/** A dial that answers one token response and records what was sent. */
function fakeDial() {
  const seen: Array<{ body: URLSearchParams; headers: Record<string, string> }> = []
  const dial = (async (_url: string, init?: { body?: string; headers?: Record<string, string> }) => {
    seen.push({ body: new URLSearchParams(init?.body ?? ''), headers: init?.headers ?? {} })
    const json = { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }
    return { ok: true, response: { status: 200, headers: {}, text: JSON.stringify(json), json } }
  }) as Dial
  return { dial, seen }
}

const confidential: TokenClient = {
  tokenEndpoint: ENDPOINT,
  clientId: 'client-1',
  clientSecret: 'secret-1',
  resource: 'https://mcp.example.test/mcp'
}

describe('clientSecretAuthFor', () => {
  it('defaults to Basic when the server publishes nothing', () => {
    expect(clientSecretAuthFor(undefined)).toBe('basic')
  })

  it('keeps Basic whenever the server accepts it', () => {
    expect(clientSecretAuthFor(['client_secret_post', 'client_secret_basic'])).toBe('basic')
  })

  it('switches to the form body only for a server that takes nothing but client_secret_post', () => {
    expect(clientSecretAuthFor(['client_secret_post'])).toBe('post')
    expect(clientSecretAuthFor(['private_key_jwt'])).toBe('basic')
  })
})

describe('token endpoint client authentication', () => {
  it('sends the secret as HTTP Basic by default', async () => {
    const { dial, seen } = fakeDial()
    const result = await exchangeCode(
      dial,
      confidential,
      { code: 'code-1', redirectUri: 'https://cp.example.test/cb', codeVerifier: 'v' },
      NOW
    )
    expect(result.ok).toBe(true)
    expect(seen[0]!.headers.authorization).toBe(`Basic ${Buffer.from('client-1:secret-1').toString('base64')}`)
    expect(seen[0]!.body.get('client_secret')).toBeNull()
    expect(seen[0]!.body.get('client_id')).toBe('client-1')
  })

  it('puts the secret in the form body, and nothing in the header, for client_secret_post', async () => {
    const { dial, seen } = fakeDial()
    const client: TokenClient = { ...confidential, clientSecretAuth: 'post' }
    await exchangeCode(
      dial,
      client,
      { code: 'code-1', redirectUri: 'https://cp.example.test/cb', codeVerifier: 'v' },
      NOW
    )
    await refreshGrant(dial, client, 'refresh-1', NOW)
    for (const call of seen) {
      expect(call.headers.authorization).toBeUndefined()
      expect(call.body.get('client_secret')).toBe('secret-1')
      expect(call.body.get('client_id')).toBe('client-1')
    }
    expect(seen[1]!.body.get('grant_type')).toBe('refresh_token')
  })

  it('sends no credential at all for a public client', async () => {
    const { dial, seen } = fakeDial()
    const { clientSecret: _omit, ...publicClient } = confidential
    await refreshGrant(dial, { ...publicClient, clientSecretAuth: 'post' }, 'refresh-1', NOW)
    expect(seen[0]!.headers.authorization).toBeUndefined()
    expect(seen[0]!.body.get('client_secret')).toBeNull()
  })
})
