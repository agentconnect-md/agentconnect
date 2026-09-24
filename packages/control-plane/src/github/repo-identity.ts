import { createHash, randomBytes } from 'node:crypto'
import { LRUCache } from 'lru-cache'
import { z } from 'zod'
import { cacheOptions } from '../cache.js'
import type { Clock } from '../domain/clock.js'
import type {
  GithubInstallationRecord,
  GithubRepoIdentityStore,
  SocialIdentityMutationGate
} from '../persistence/ports.js'
import { DEPLOYMENT_SCOPE, type SecretCipher } from '../secrets/cipher.js'
import type { FetchLike } from './api.js'
import type { GithubService } from './service.js'

export interface GithubRepoIdentitySummary {
  githubUserId: string
  login: string
}

export interface GithubRepoIdentityLookup {
  summaryForSubject(sub: string): Promise<GithubRepoIdentitySummary | undefined>
  loginForSubject(sub: string, installation: GithubInstallationRecord, maxAgeMs?: number): Promise<string | null>
  clearBySubject(sub: string): Promise<void>
}

export class GithubRepoIdentityError extends Error {
  constructor(
    readonly status: 400 | 409 | 502 | 503,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

interface GithubRepoIdentityDeps {
  store: GithubRepoIdentityStore
  mutations: SocialIdentityMutationGate
  clock: Clock
  cipher: SecretCipher
  github: Pick<GithubService, 'userById'>
  assertLinkable(sub: string): Promise<void>
  invalidate(sub: string): void
  oauth?: { clientId: string; clientSecret: string; redirectUri: string }
  fetchImpl?: FetchLike
}

const UserDto = z.object({ id: z.number().int().positive().safe(), login: z.string().min(1) })
const STATE_TTL_MS = 10 * 60_000
const LOGIN_TTL_MS = 60_000

// Repository-only identities never become sign-in methods or replace a linked social identity.
export class GithubRepoIdentityService implements GithubRepoIdentityLookup {
  private readonly logins: LRUCache<
    string,
    { login: string | null },
    { installation: GithubInstallationRecord; id: bigint }
  >

  constructor(private readonly deps: GithubRepoIdentityDeps) {
    this.logins = new LRUCache({
      ...cacheOptions(deps.clock, 10_000),
      ttl: LOGIN_TTL_MS,
      fetchMethod: async (_key, _stale, { context }) => ({
        login: (await deps.github.userById(context.installation, context.id))?.login ?? null
      })
    })
  }

  get enabled(): boolean {
    return this.deps.oauth !== undefined
  }

  async summaryForSubject(sub: string): Promise<GithubRepoIdentitySummary | undefined> {
    const identity = await this.deps.store.findBySubject(sub)
    return identity ? { githubUserId: String(identity.githubUserId), login: identity.login } : undefined
  }

  async loginForSubject(
    sub: string,
    installation: GithubInstallationRecord,
    maxAgeMs?: number
  ): Promise<string | null> {
    // Read the binding on every fallback so connect/disconnect is visible across CP replicas.
    const identity = await this.deps.store.findBySubject(sub)
    if (!identity) return null
    const key = `${installation.installationId}:${identity.githubUserId}`
    const age = LOGIN_TTL_MS - this.logins.getRemainingTTL(key)
    const user = await this.logins.fetch(key, {
      ...(maxAgeMs !== undefined && age >= maxAgeMs ? { forceRefresh: true } : {}),
      context: { installation, id: identity.githubUserId }
    })
    return user?.login ?? null
  }

  async clearBySubject(sub: string): Promise<void> {
    await this.deps.store.clearBySubject(sub)
    this.deps.invalidate(sub)
  }

  async disconnect(sub: string): Promise<void> {
    await this.deps.mutations.runExclusive(sub, () => this.clearBySubject(sub))
  }

  async authorize(userId: string, sub: string): Promise<{ state: string; authorizationUri: string }> {
    const oauth = this.oauth()
    return this.deps.mutations.runExclusive(sub, async () => {
      await this.assertLinkable(sub)
      const state = randomBytes(32).toString('base64url')
      const verifier = randomBytes(32).toString('base64url')
      const now = new Date(this.deps.clock.now())
      await this.deps.store.createState(
        {
          nonce: state,
          userId,
          verifier: await this.deps.cipher.seal(verifier, DEPLOYMENT_SCOPE),
          expiresAt: new Date(now.getTime() + STATE_TTL_MS)
        },
        now
      )
      const url = new URL('https://github.com/login/oauth/authorize')
      url.search = new URLSearchParams({
        client_id: oauth.clientId,
        redirect_uri: oauth.redirectUri,
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256'
      }).toString()
      return { state, authorizationUri: url.toString() }
    })
  }

  async complete(userId: string, sub: string, code: string, nonce: string): Promise<GithubRepoIdentitySummary> {
    const oauth = this.oauth()
    // Keep the same per-subject lock through exchange and persistence; disconnect also cancels pending states.
    return this.deps.mutations.runExclusive(sub, async () => {
      const state = await this.deps.store.findState(userId, nonce, new Date(this.deps.clock.now()))
      if (!state) {
        throw new GithubRepoIdentityError(
          400,
          'GITHUB_REPO_AUTHORIZATION_INVALID',
          'the authorization is invalid or expired'
        )
      }
      const verifier = await this.deps.cipher.open(state.verifier, DEPLOYMENT_SCOPE)
      const tokenResponse = await this.request('https://github.com/login/oauth/access_token', {
        method: 'POST',
        body: new URLSearchParams({
          client_id: oauth.clientId,
          client_secret: oauth.clientSecret,
          redirect_uri: oauth.redirectUri,
          code,
          code_verifier: verifier
        })
      })
      const token = z.object({ access_token: z.string().min(1) }).safeParse(await this.json(tokenResponse))
      if (!token.success) {
        throw new GithubRepoIdentityError(
          400,
          'GITHUB_REPO_AUTHORIZATION_INVALID',
          'the authorization could not be used'
        )
      }
      const accessToken = token.data.access_token
      let user: z.infer<typeof UserDto>
      try {
        const response = await this.request('https://api.github.com/user', {
          headers: { Authorization: `Bearer ${accessToken}` }
        })
        const parsed = UserDto.safeParse(await this.json(response))
        if (!parsed.success) {
          throw new GithubRepoIdentityError(
            502,
            'GITHUB_REPO_AUTHORIZATION_FAILED',
            'GitHub returned an invalid identity'
          )
        }
        user = parsed.data
      } finally {
        // Revoke only this token, never the user's App grant or their other tokens.
        await this.request(`https://api.github.com/applications/${encodeURIComponent(oauth.clientId)}/token`, {
          method: 'DELETE',
          headers: {
            Authorization: `Basic ${Buffer.from(`${oauth.clientId}:${oauth.clientSecret}`).toString('base64')}`
          },
          body: JSON.stringify({ access_token: accessToken })
        }).catch(() => undefined)
      }
      await this.assertLinkable(sub)
      // Consume and save atomically so cancellation still wins if the outer lock ever times out.
      const saved = await this.deps.store.completeState(
        nonce,
        { userId, githubUserId: BigInt(user.id), login: user.login },
        new Date(this.deps.clock.now())
      )
      if (!saved)
        throw new GithubRepoIdentityError(
          400,
          'GITHUB_REPO_AUTHORIZATION_INVALID',
          'the authorization is invalid or expired'
        )
      this.deps.invalidate(sub)
      return { githubUserId: String(user.id), login: user.login }
    })
  }

  private async assertLinkable(sub: string): Promise<void> {
    await this.deps.assertLinkable(sub)
    if (await this.deps.store.findBySubject(sub)) {
      throw new GithubRepoIdentityError(
        409,
        'GITHUB_REPO_ALREADY_LINKED',
        'disconnect the current repository identity before connecting another'
      )
    }
  }

  private oauth(): NonNullable<GithubRepoIdentityDeps['oauth']> {
    if (!this.deps.oauth) {
      throw new GithubRepoIdentityError(
        503,
        'GITHUB_REPO_AUTHORIZATION_UNAVAILABLE',
        'repository authorization is not configured'
      )
    }
    return this.deps.oauth
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      const response = await (this.deps.fetchImpl ?? fetch)(url, {
        ...init,
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          ...(typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers
        },
        signal: AbortSignal.timeout(5_000)
      })
      if (response.ok) return response
    } catch {
      // Network errors may carry credential-bearing request details; expose only a fixed message.
    }
    throw new GithubRepoIdentityError(
      502,
      'GITHUB_REPO_AUTHORIZATION_FAILED',
      'GitHub authorization is temporarily unavailable'
    )
  }

  private async json(response: Response): Promise<unknown> {
    try {
      return await response.json()
    } catch {
      throw new GithubRepoIdentityError(502, 'GITHUB_REPO_AUTHORIZATION_FAILED', 'GitHub returned an invalid response')
    }
  }
}
