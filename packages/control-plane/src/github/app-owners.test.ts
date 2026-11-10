import { describe, expect, it, vi } from 'vitest'
import { GithubAppOwnersService } from './app-owners.js'

const oauth = {
  clientId: 'example-client',
  clientSecret: 'example-secret',
  redirectUri: 'https://console.example.test/auth/social/callback'
}

describe('GitHub App owner discovery', () => {
  it('lists all membership pages and revokes the temporary user token', async () => {
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/access_token')) {
        expect(new URLSearchParams(init?.body as URLSearchParams).get('code_verifier')).toBe('example-verifier')
        return Response.json({ access_token: 'example-token' })
      }
      if (url.endsWith('/token')) return new Response(null, { status: 204 })
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer example-token')
      if (url.endsWith('/user')) return Response.json({ login: 'example-user' })
      if (url.endsWith('page=1'))
        return Response.json(
          [
            { state: 'active', organization: { login: 'example-org' } },
            { state: 'pending', organization: { login: 'pending-org' } }
          ],
          { headers: { link: '<https://api.github.com/user/memberships/orgs?page=2>; rel="next"' } }
        )
      return Response.json([{ state: 'active', organization: { login: 'another-org' } }])
    })
    const service = new GithubAppOwnersService(oauth, request)
    const authorization = new URL(service.authorize('example-state', 'example-challenge').authorizationUri)
    expect(authorization.searchParams.get('code_challenge')).toBe('example-challenge')
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorization.searchParams.get('redirect_uri')).toBe(oauth.redirectUri)
    await expect(service.list('example-code', 'example-verifier')).resolves.toEqual({
      personal: 'example-user',
      organizations: ['another-org', 'example-org']
    })
    expect(request.mock.lastCall).toEqual([
      'https://api.github.com/applications/example-client/token',
      expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ access_token: 'example-token' }) })
    ])
  })

  it('revokes the token when discovery fails and never exposes upstream credentials', async () => {
    const request = vi.fn(async (url: string) => {
      if (url.endsWith('/access_token')) return Response.json({ access_token: 'example-token' })
      if (url.endsWith('/token')) return new Response(null, { status: 204 })
      throw new Error('sensitive upstream content')
    })
    await expect(new GithubAppOwnersService(oauth, request).list('code', 'verifier')).rejects.toThrow(
      'Could not load GitHub accounts'
    )
    expect(request.mock.lastCall?.[0]).toBe('https://api.github.com/applications/example-client/token')
  })
})
