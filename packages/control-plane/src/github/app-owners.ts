import { z } from 'zod'
import { GithubApiError, type FetchLike } from './api.js'

const Account = z.object({ login: z.string().min(1) })
const Memberships = z.array(z.object({ state: z.string(), organization: Account }))

// Read account choices with a temporary user token; never persist it or change a linked identity.
export class GithubAppOwnersService {
  constructor(
    private readonly oauth: { clientId: string; clientSecret: string; redirectUri: string },
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  authorize(state: string, challenge: string): { authorizationUri: string } {
    const url = new URL('https://github.com/login/oauth/authorize')
    url.search = new URLSearchParams({
      client_id: this.oauth.clientId,
      redirect_uri: this.oauth.redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    }).toString()
    return { authorizationUri: url.toString() }
  }

  async list(code: string, verifier: string): Promise<{ personal: string; organizations: string[] }> {
    const response = await this.request('https://github.com/login/oauth/access_token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: this.oauth.clientId,
        client_secret: this.oauth.clientSecret,
        redirect_uri: this.oauth.redirectUri,
        code,
        code_verifier: verifier
      })
    })
    const token = z.object({ access_token: z.string().min(1) }).safeParse(await this.json(response))
    if (!token.success) throw this.failure()
    const accessToken = token.data.access_token
    try {
      const headers = { Authorization: `Bearer ${accessToken}` }
      const user = Account.safeParse(await this.json(await this.request('https://api.github.com/user', { headers })))
      if (!user.success) throw this.failure()
      const organizations = new Set<string>()
      for (let page = 1; ; page++) {
        const membershipsResponse = await this.request(
          `https://api.github.com/user/memberships/orgs?state=active&per_page=100&page=${page}`,
          { headers }
        )
        const memberships = Memberships.safeParse(await this.json(membershipsResponse))
        if (!memberships.success) throw this.failure()
        for (const membership of memberships.data) {
          if (membership.state === 'active') organizations.add(membership.organization.login)
        }
        if (!membershipsResponse.headers.get('link')?.includes('rel="next"')) break
        if (page >= 100) throw this.failure()
      }
      return { personal: user.data.login, organizations: [...organizations].sort((a, b) => a.localeCompare(b)) }
    } finally {
      // Revoke this token only, preserving the user's App grant and other tokens.
      await this.request(`https://api.github.com/applications/${encodeURIComponent(this.oauth.clientId)}/token`, {
        method: 'DELETE',
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.oauth.clientId}:${this.oauth.clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ access_token: accessToken })
      }).catch(() => undefined)
    }
  }

  private failure(): GithubApiError {
    return new GithubApiError('Could not load GitHub accounts. Authorize GitHub and try again.', 502, 'INTERNAL', false)
  }

  private async json(response: Response): Promise<unknown> {
    try {
      return await response.json()
    } catch {
      throw this.failure()
    }
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        redirect: 'error',
        headers: { Accept: 'application/json', ...init.headers },
        signal: AbortSignal.timeout(5_000)
      })
      if (response.ok) return response
    } catch {
      // Do not expose credential-bearing upstream errors.
    }
    throw this.failure()
  }
}
