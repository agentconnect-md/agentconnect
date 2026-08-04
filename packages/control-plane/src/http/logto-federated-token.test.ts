import { describe, expect, it, vi } from 'vitest'
import {
  LogtoFederatedTokenError,
  LogtoFederatedTokenService,
  logtoAccountEndpointFromIssuer
} from './logto-federated-token.js'

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

  it('keeps only a safe upstream code when federated authorization is unavailable', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/api/my-account')
        ? json({ id: 'logto-user' })
        : json({ code: 'connector.general', message: 'refresh token secret must not escape' }, 400)
    )
    const session = new LogtoFederatedTokenService('https://login.example.test', fetchImpl).forRequest(
      'logto-user',
      'account-token'
    )

    const error = await session.accessTokenFor('lark').catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(LogtoFederatedTokenError)
    expect(error).toMatchObject({
      stage: 'federated_token',
      target: 'lark',
      status: 400,
      code: 'connector.general'
    })
    expect(String(error)).not.toContain('refresh token secret')
    expect(JSON.stringify(error)).not.toContain('refresh token secret')
    expect(JSON.stringify(error)).not.toContain('account-token')
  })
})
