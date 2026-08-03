import { describe, expect, it, vi } from 'vitest'
import { LogtoFederatedTokenService, logtoAccountEndpointFromIssuer } from './logto-federated-token.js'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('LogtoFederatedTokenService', () => {
  it('derives the Account API origin from the configured OIDC issuer', () => {
    expect(logtoAccountEndpointFromIssuer('https://login.example.test/oidc')).toBe('https://login.example.test')
  })

  it('binds the Account API token to the OIDC subject before returning a provider token', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer account-token')
      return url.endsWith('/api/my-account') ? json({ id: 'logto-user' }) : json({ access_token: 'lark-token' })
    })
    const session = new LogtoFederatedTokenService('https://login.example.test/', fetchImpl).forRequest(
      'logto-user',
      'account-token'
    )

    await expect(Promise.all([session.accessTokenFor('lark'), session.accessTokenFor('lark')])).resolves.toEqual([
      'lark-token',
      'lark-token'
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('rejects a token issued for a different Logto account without reading provider credentials', async () => {
    const fetchImpl = vi.fn(async () => json({ id: 'another-user' }))
    const session = new LogtoFederatedTokenService('https://login.example.test', fetchImpl).forRequest(
      'logto-user',
      'account-token'
    )

    await expect(session.accessTokenFor('lark')).rejects.toMatchObject({ status: 403 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
