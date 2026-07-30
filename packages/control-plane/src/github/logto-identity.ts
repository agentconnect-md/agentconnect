/**
 * LogtoIdentityService — the Control Plane's one deliberate Logto coupling.
 *
 * It resolves a console user's GitHub login for repo authorization and lets an
 * authenticated user link or unlink their own social sign-in methods from the
 * AgentConnect Profile UI. Both use Logto's Management API behind the CP; its
 * M2M credential never reaches the browser. We read identity metadata only and
 * never retain social access tokens.
 *
 * Auth: M2M client-credentials against `${endpoint}/oidc/token` with the
 * Management API resource indicator (default `${endpoint}/api`; cloud tenants
 * behind a custom domain must set LOGTO_MGMT_RESOURCE to the canonical
 * `https://tenant.example.com/api`).
 *
 * Caching: the M2M token until 60s before expiry; sub→login 10 min positive /
 * 60 s negative (a user who just linked GitHub should not wait long), both
 * single-flight. All lookups fail CLOSED at the callers (authorization gate).
 */
import type { Clock } from '../domain/clock.js'
import type { SocialIdentityMutationGate } from '../persistence/ports.js'
import type { FetchLike } from './api.js'

export interface LogtoMgmtConfig {
  /** Logto tenant origin, e.g. `https://tenant-id.logto.app` (no trailing slash). */
  endpoint: string
  appId: string
  appSecret: string
  /** Management API resource indicator; defaults to `${endpoint}/api`. */
  resource: string
}

/** All-or-none decode of LOGTO_MGMT_* (resource optional). Undefined ⇒ feature off. */
export function resolveLogtoMgmtConfig(env: {
  LOGTO_MGMT_ENDPOINT?: string
  LOGTO_MGMT_APP_ID?: string
  LOGTO_MGMT_APP_SECRET?: string
  LOGTO_MGMT_RESOURCE?: string
}): LogtoMgmtConfig | undefined {
  const { LOGTO_MGMT_ENDPOINT, LOGTO_MGMT_APP_ID, LOGTO_MGMT_APP_SECRET } = env
  if (!LOGTO_MGMT_ENDPOINT && !LOGTO_MGMT_APP_ID && !LOGTO_MGMT_APP_SECRET) return undefined
  const missing = [
    !LOGTO_MGMT_ENDPOINT && 'LOGTO_MGMT_ENDPOINT',
    !LOGTO_MGMT_APP_ID && 'LOGTO_MGMT_APP_ID',
    !LOGTO_MGMT_APP_SECRET && 'LOGTO_MGMT_APP_SECRET'
  ].filter(Boolean)
  if (missing.length > 0) {
    throw new Error(`logto mgmt config is partial — missing ${missing.join(', ')}`)
  }
  const endpoint = LOGTO_MGMT_ENDPOINT!.replace(/\/$/, '')
  return {
    endpoint,
    appId: LOGTO_MGMT_APP_ID!,
    appSecret: LOGTO_MGMT_APP_SECRET!,
    resource: env.LOGTO_MGMT_RESOURCE ?? `${endpoint}/api`
  }
}

/** Non-2xx/network failure from Logto. `retryable` mirrors GithubApiError semantics. */
export class LogtoApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly code?: string
  ) {
    super(message)
    this.name = 'LogtoApiError'
  }
}

const TOKEN_SKEW_MS = 60_000
const LOGIN_TTL_MS = 10 * 60_000
const NEGATIVE_TTL_MS = 60_000
const TIMEOUT_MS = 10_000

interface CachedLogin {
  login: string | null
  expiresAt: number
}

interface CachedSlack {
  identity: SlackIdentity | null
  expiresAt: number
}

/** The Slack workspace identity behind a console account. Both ids are required —
 *  a `U…` without its `T…` is not addressable, so a partial read is no read. */
export interface SlackIdentity {
  /** Slack workspace id (`T…`). */
  teamId: string
  /** Slack user id (`U…`) — scoped to that workspace. */
  userId: string
  teamName?: string
  teamDomain?: string
}

// Slack namespaces its non-standard OIDC claims. `sub` carries the same user id
// as `https://slack.com/user_id`; team_name/team_domain are best-effort (Slack's
// published claim list guarantees only the two ids).
const SLACK_CLAIM = {
  teamId: 'https://slack.com/team_id',
  userId: 'https://slack.com/user_id',
  teamName: 'https://slack.com/team_name',
  teamDomain: 'https://slack.com/team_domain'
} as const

/** The Logto user shape we read — identities metadata only. */
interface LogtoUser {
  identities?: Record<
    string,
    {
      userId?: string
      details?: {
        // The connector's raw profile. Logto's github connector stores the
        // GitHub /user response under `rawData` (login at `userInfo.login` on
        // current connectors; older ones kept the flat `login`); the slack
        // connector stores the whole decoded OIDC payload there.
        rawData?: { userInfo?: { login?: unknown }; login?: unknown } & Record<string, unknown>
      }
    }
  >
}

export class LogtoIdentityService {
  private token?: { value: string; expiresAt: number }
  private tokenInFlight?: Promise<string>
  private readonly logins = new Map<string, CachedLogin>()
  private readonly loginInFlight = new Map<string, Promise<string | null>>()
  // Kept separate from the login cache on purpose: githubLoginFor sits on a live
  // authorization gate, and a display-only Slack read must not be able to shift
  // what that gate sees (or when it re-asks).
  private readonly slacks = new Map<string, CachedSlack>()
  private readonly slackInFlight = new Map<string, Promise<SlackIdentity | null>>()

  constructor(
    private readonly cfg: LogtoMgmtConfig,
    private readonly clock: Clock,
    private readonly mutations: SocialIdentityMutationGate,
    private readonly fetchImpl: FetchLike = fetch as FetchLike
  ) {}

  /**
   * The GitHub login behind a local user's OIDC subject, or null when the
   * account has no GitHub identity (e.g. Google sign-in) — callers map null to
   * a GITHUB_IDENTITY_REQUIRED denial, never a silent allow.
   */
  async githubLoginFor(sub: string): Promise<string | null> {
    const cached = this.logins.get(sub)
    if (cached && cached.expiresAt > this.clock.now()) return cached.login
    let pending = this.loginInFlight.get(sub)
    if (!pending) {
      pending = this.lookupLogin(sub).finally(() => this.loginInFlight.delete(sub))
      this.loginInFlight.set(sub, pending)
    }
    return pending
  }

  /**
   * The Slack workspace identity behind a local user's OIDC subject, or null
   * when the account never signed in with (or linked) Slack. Read-only
   * metadata — no caller may treat this as an authorization decision.
   */
  async slackIdentityFor(sub: string): Promise<SlackIdentity | null> {
    const cached = this.slacks.get(sub)
    if (cached && cached.expiresAt > this.clock.now()) return cached.identity
    let pending = this.slackInFlight.get(sub)
    if (!pending) {
      pending = this.lookupSlack(sub).finally(() => this.slackInFlight.delete(sub))
      this.slackInFlight.set(sub, pending)
    }
    return pending
  }

  /** Resolve a statically supported provider target and build its link URL. */
  async createSocialAuthorization(
    target: string,
    redirectUri: string,
    state: string
  ): Promise<{ connectorId: string; redirectTo: string }> {
    const connectorsRes = await this.request(`/api/connectors?target=${encodeURIComponent(target)}`)
    if (!connectorsRes.ok) throw await this.responseError('logto social connector lookup', connectorsRes)
    const connectors: unknown = await connectorsRes.json()
    const connector = Array.isArray(connectors)
      ? connectors.find((entry) => {
          if (!entry || typeof entry !== 'object') return false
          const value = entry as { target?: unknown; type?: unknown }
          return value.target === target && value.type === 'Social'
        })
      : undefined
    const connectorId =
      connector && typeof (connector as { id?: unknown }).id === 'string' ? (connector as { id: string }).id : undefined
    if (!connectorId) throw new LogtoApiError('social connector not found', 404, false)

    const res = await this.request(`/api/connectors/${encodeURIComponent(connectorId)}/authorization-uri`, {
      method: 'POST',
      body: JSON.stringify({ redirectUri, state })
    })
    if (!res.ok) throw await this.responseError('logto social authorization', res)
    const body = (await res.json()) as { redirectTo?: unknown }
    if (typeof body.redirectTo !== 'string' || body.redirectTo.length === 0) {
      throw new LogtoApiError('logto social authorization response missing redirectTo', 502, false)
    }
    return { connectorId, redirectTo: body.redirectTo }
  }

  /** Link the provider identity proved by `connectorData` to this Logto user. */
  async linkSocialIdentity(sub: string, connectorId: string, connectorData: Record<string, string>): Promise<void> {
    const res = await this.request(`/api/users/${encodeURIComponent(sub)}/identities`, {
      method: 'POST',
      body: JSON.stringify({ connectorId, connectorData })
    })
    if (!res.ok) throw await this.responseError('logto social identity link', res)
    this.invalidate(sub)
  }

  /** Remove one provider identity from this Logto user. */
  async unlinkSocialIdentity(sub: string, target: string): Promise<void> {
    // Refresh outside the database critical section when needed; normal requests
    // then reuse the cached token for the complete read/check/delete cycle.
    await this.mgmtToken()
    await this.mutations.runExclusive(sub, async () => {
      const userRes = await this.request(`/api/users/${encodeURIComponent(sub)}`)
      if (!userRes.ok) throw await this.responseError('logto user lookup', userRes)
      const user = (await userRes.json()) as LogtoUser
      const targets = Object.keys(user.identities ?? {})
      if (!targets.includes(target)) {
        throw new LogtoApiError('social identity not linked', 404, false)
      }
      if (targets.length === 1) {
        throw new LogtoApiError('the last social sign-in method cannot be removed', 409, false, 'LAST_SOCIAL_IDENTITY')
      }
      const res = await this.request(`/api/users/${encodeURIComponent(sub)}/identities/${encodeURIComponent(target)}`, {
        method: 'DELETE'
      })
      if (!res.ok) throw await this.responseError('logto social identity unlink', res)
      this.invalidate(sub)
    })
  }

  /** Drop every cached identity for one user. Called after a link/unlink, so the
   *  Profile does not keep showing a method the user just changed. */
  private invalidate(sub: string): void {
    this.logins.delete(sub)
    this.slacks.delete(sub)
  }

  private async lookupSlack(sub: string): Promise<SlackIdentity | null> {
    const res = await this.request(`/api/users/${encodeURIComponent(sub)}`)
    if (res.status === 404) {
      this.slacks.set(sub, { identity: null, expiresAt: this.clock.now() + NEGATIVE_TTL_MS })
      return null
    }
    if (!res.ok) {
      throw new LogtoApiError(`logto user lookup failed: ${res.status}`, res.status, res.status >= 500)
    }
    const user = (await res.json()) as LogtoUser
    const identity = slackIdentityOf(user)
    this.slacks.set(sub, {
      identity,
      expiresAt: this.clock.now() + (identity ? LOGIN_TTL_MS : NEGATIVE_TTL_MS)
    })
    return identity
  }

  private async lookupLogin(sub: string): Promise<string | null> {
    const res = await this.request(`/api/users/${encodeURIComponent(sub)}`)
    if (res.status === 404) {
      // Deleted at the provider — no identity, cache the miss briefly.
      this.logins.set(sub, { login: null, expiresAt: this.clock.now() + NEGATIVE_TTL_MS })
      return null
    }
    if (!res.ok) {
      throw new LogtoApiError(`logto user lookup failed: ${res.status}`, res.status, res.status >= 500)
    }
    const user = (await res.json()) as LogtoUser
    const raw = user.identities?.github?.details?.rawData
    const login = firstString(raw?.userInfo?.login, raw?.login)
    this.logins.set(sub, {
      login,
      expiresAt: this.clock.now() + (login ? LOGIN_TTL_MS : NEGATIVE_TTL_MS)
    })
    return login
  }

  private async responseError(action: string, res: Response): Promise<LogtoApiError> {
    let detail: { code?: unknown; message?: unknown } = {}
    try {
      detail = (await res.json()) as typeof detail
    } catch {
      // A status and stable operation label are enough when Logto returns no JSON.
    }
    const code = typeof detail.code === 'string' ? detail.code : undefined
    const message =
      typeof detail.message === 'string' && detail.message.length > 0
        ? `${action} failed: ${detail.message}`
        : `${action} failed: ${res.status}`
    return new LogtoApiError(message, res.status, res.status >= 500 || res.status === 429, code)
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.mgmtToken()
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${token}`)
    if (init.body) headers.set('content-type', 'application/json')
    try {
      return await this.fetchImpl(`${this.cfg.endpoint}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
    } catch (e) {
      throw new LogtoApiError(`logto unreachable: ${(e as Error).message}`, 0, true)
    }
  }

  private mgmtToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.clock.now()) return Promise.resolve(this.token.value)
    if (!this.tokenInFlight) {
      this.tokenInFlight = this.fetchToken().finally(() => (this.tokenInFlight = undefined))
    }
    return this.tokenInFlight
  }

  private async fetchToken(): Promise<string> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.cfg.endpoint}/oidc/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${Buffer.from(`${this.cfg.appId}:${this.cfg.appSecret}`).toString('base64')}`
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          resource: this.cfg.resource,
          scope: 'all'
        }).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
    } catch (e) {
      throw new LogtoApiError(`logto token endpoint unreachable: ${(e as Error).message}`, 0, true)
    }
    if (!res.ok) {
      throw new LogtoApiError(`logto m2m token failed: ${res.status}`, res.status, res.status >= 500)
    }
    const body = (await res.json()) as { access_token?: string; expires_in?: number }
    if (!body.access_token) throw new LogtoApiError('logto m2m token response missing access_token', 502, false)
    this.token = {
      value: body.access_token,
      expiresAt: this.clock.now() + Math.max(0, (body.expires_in ?? 0) * 1000 - TOKEN_SKEW_MS)
    }
    return body.access_token
  }
}

function firstString(...candidates: unknown[]): string | null {
  for (const c of candidates) if (typeof c === 'string' && c.length > 0) return c
  return null
}

/** Read the Slack workspace identity out of a Logto user, or null when the
 *  account has no usable one. */
function slackIdentityOf(user: LogtoUser): SlackIdentity | null {
  const identity = user.identities?.slack
  const raw = identity?.details?.rawData
  if (!raw) return null
  const teamId = firstString(raw[SLACK_CLAIM.teamId])
  // Slack's `sub` IS the user id, so the stored identity key is an equally
  // authoritative fallback when the namespaced claim is absent.
  const userId = firstString(raw[SLACK_CLAIM.userId], identity?.userId)
  if (!teamId || !userId) return null
  const teamName = firstString(raw[SLACK_CLAIM.teamName])
  const teamDomain = firstString(raw[SLACK_CLAIM.teamDomain])
  return {
    teamId,
    userId,
    ...(teamName ? { teamName } : {}),
    ...(teamDomain ? { teamDomain } : {})
  }
}
