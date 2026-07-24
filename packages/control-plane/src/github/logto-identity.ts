/**
 * LogtoIdentityService — resolves a console user's GitHub **login** server-side
 * (docs/designs/github-app-git-credentials.md open question #7, identity-assertion route).
 *
 * The CP is otherwise a provider-agnostic OIDC resource server; this is the ONE
 * deliberate Logto coupling, opt-in via `LOGTO_MGMT_*` config (all-or-none,
 * mirroring `GITHUB_APP_*`). It reads identity METADATA only — the GitHub login
 * a user signed in with — never social tokens (those are end-user-Account-API
 * territory by Logto's design and we don't want them).
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
    readonly retryable: boolean
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

/** The Logto user shape we read — identities metadata only. */
interface LogtoUser {
  identities?: Record<
    string,
    {
      userId?: string
      details?: {
        // The connector's raw profile; Logto's github connector stores the
        // GitHub /user response under `rawData` (login at `userInfo.login` on
        // current connectors; older ones kept the flat `login`).
        rawData?: { userInfo?: { login?: unknown }; login?: unknown }
      }
    }
  >
}

export class LogtoIdentityService {
  private token?: { value: string; expiresAt: number }
  private tokenInFlight?: Promise<string>
  private readonly logins = new Map<string, CachedLogin>()
  private readonly loginInFlight = new Map<string, Promise<string | null>>()

  constructor(
    private readonly cfg: LogtoMgmtConfig,
    private readonly clock: Clock,
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

  private async request(path: string): Promise<Response> {
    const token = await this.mgmtToken()
    try {
      return await this.fetchImpl(`${this.cfg.endpoint}${path}`, {
        headers: { authorization: `Bearer ${token}` },
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
