/**
 * Linear's OAuth + viewer surface, as the CP uses it (docs/designs/linear-integration.md §4.4, §7.1).
 *
 * Every endpoint is INJECTABLE so the whole install lifecycle runs against a stubbed Linear in
 * tests; production takes the defaults below and nothing else in the process composes a Linear URL.
 *
 * Outcomes are three-valued, the same distinction the CP draws everywhere it talks to a provider:
 * `ok`, a DEFINITIVE `rejected` (Linear answered, and the answer will not change on retry), and
 * `unreachable` (a blip — never proof the credential is bad). The refresh path leans on that split:
 * only a rejection may spend the reload-retry, and only a rejection may flip a workspace to
 * "reconnect required".
 */
import type { FetchLike } from '../../github/api.js'
import { systemClock, type Clock } from '../../domain/clock.js'

export interface LinearOAuthEndpoints {
  /** Where the operator's browser is sent to authorize a workspace. */
  authorizeUrl: string
  tokenUrl: string
  revokeUrl: string
  graphqlUrl: string
}

export const LINEAR_ENDPOINTS: LinearOAuthEndpoints = {
  authorizeUrl: 'https://linear.app/oauth/authorize',
  tokenUrl: 'https://api.linear.app/oauth/token',
  revokeUrl: 'https://api.linear.app/oauth/revoke',
  graphqlUrl: 'https://api.linear.app/graphql'
}

/** The scopes a connected workspace grants (§7.1). `actor=app` is what makes the grant an APP
 *  actor, which is the whole premise of the agent surface. */
export const LINEAR_OAUTH_SCOPES = ['read', 'write', 'app:assignable', 'app:mentionable'] as const

/** A grant as Linear issued it. `refreshToken` is null when the response carried none — nothing to
 *  rotate with, so the workspace can only be repaired by re-connecting. */
export interface LinearGrant {
  accessToken: string
  refreshToken: string | null
  expiresAt: Date
}

/** The app's own identity inside the workspace that just authorized it. */
export interface LinearViewer {
  /** The app user id — the self-echo guard and the shared-bot addressing input. */
  appUserId: string
  organizationId: string
  organizationName: string | null
}

export type LinearApiResult<T> =
  { ok: true; result: T } | { ok: false; error: 'rejected' | 'unreachable'; detail?: string }

/** Linear's default access-token lifetime, used when a token response omits `expires_in`. */
const DEFAULT_EXPIRES_IN_SEC = 24 * 60 * 60

/**
 * Per-request ceiling. Node's `fetch` has no default timeout, so without this a hung Linear pins the
 * caller indefinitely — which for the orphan sweep would mean pinning a Postgres transaction (it
 * revokes while holding the identity's advisory lock) until the transaction budget killed it. Well
 * under that budget, so the HTTP call always loses the race and surfaces as `unreachable`.
 */
const REQUEST_TIMEOUT_MS = 10_000

/** `AbortSignal.timeout` rejects with a TimeoutError, which every caller here already maps to
 *  `unreachable` — the honest answer for "we never heard back". */
const withTimeout = (init: RequestInit): RequestInit => ({ ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })

interface TokenResponse {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
}

export interface LinearApiOptions {
  fetchImpl?: FetchLike
  endpoints?: Partial<LinearOAuthEndpoints>
  /** `expires_in` is relative, so the absolute expiry this derives is time-dependent. */
  clock?: Clock
}

export class LinearApiClient {
  private readonly fetchImpl: FetchLike
  private readonly clock: Clock
  readonly endpoints: LinearOAuthEndpoints

  constructor(opts: LinearApiOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init))
    this.clock = opts.clock ?? systemClock
    this.endpoints = { ...LINEAR_ENDPOINTS, ...opts.endpoints }
  }

  /** The authorize URL an org admin's browser is sent to (§7.1). Carries no secret. */
  authorizeUrl(input: { clientId: string; redirectUri: string; state: string }): string {
    const url = new URL(this.endpoints.authorizeUrl)
    url.searchParams.set('client_id', input.clientId)
    url.searchParams.set('redirect_uri', input.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', LINEAR_OAUTH_SCOPES.join(','))
    url.searchParams.set('actor', 'app')
    url.searchParams.set('state', input.state)
    return url.toString()
  }

  exchangeCode(input: {
    clientId: string
    clientSecret: string
    code: string
    redirectUri: string
  }): Promise<LinearApiResult<LinearGrant>> {
    return this.token({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      client_secret: input.clientSecret
    })
  }

  refresh(input: {
    clientId: string
    clientSecret: string
    refreshToken: string
  }): Promise<LinearApiResult<LinearGrant>> {
    return this.token({
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret
    })
  }

  /** `viewer { id organization { id name } }` — the app user and the workspace it landed in. */
  async viewer(accessToken: string): Promise<LinearApiResult<LinearViewer>> {
    let res: Response
    try {
      res = await this.fetchImpl(
        this.endpoints.graphqlUrl,
        withTimeout({
          method: 'POST',
          headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ query: 'query { viewer { id organization { id name } } }' })
        })
      )
    } catch (err) {
      return { ok: false, error: 'unreachable', detail: String(err) }
    }
    if (!res.ok)
      return { ok: false, error: res.status >= 500 ? 'unreachable' : 'rejected', detail: `http ${res.status}` }
    const body = (await res.json().catch(() => undefined)) as
      { data?: { viewer?: { id?: unknown; organization?: { id?: unknown; name?: unknown } } } } | undefined
    const viewer = body?.data?.viewer
    const appUserId = typeof viewer?.id === 'string' ? viewer.id : undefined
    const organizationId = typeof viewer?.organization?.id === 'string' ? viewer.organization.id : undefined
    // A grant that resolves no workspace cannot be keyed, demuxed, or fenced — refuse it definitively.
    if (!appUserId || !organizationId)
      return { ok: false, error: 'rejected', detail: 'viewer query returned no workspace' }
    return {
      ok: true,
      result: {
        appUserId,
        organizationId,
        organizationName: typeof viewer?.organization?.name === 'string' ? viewer.organization.name : null
      }
    }
  }

  /** Best-effort upstream teardown of one grant (§7.4). `rejected` includes "already revoked". */
  async revoke(accessToken: string): Promise<LinearApiResult<true>> {
    let res: Response
    try {
      res = await this.fetchImpl(
        this.endpoints.revokeUrl,
        withTimeout({ method: 'POST', headers: { authorization: `Bearer ${accessToken}` } })
      )
    } catch (err) {
      return { ok: false, error: 'unreachable', detail: String(err) }
    }
    if (!res.ok)
      return { ok: false, error: res.status >= 500 ? 'unreachable' : 'rejected', detail: `http ${res.status}` }
    return { ok: true, result: true }
  }

  private async token(form: Record<string, string>): Promise<LinearApiResult<LinearGrant>> {
    let res: Response
    try {
      res = await this.fetchImpl(
        this.endpoints.tokenUrl,
        withTimeout({
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(form).toString()
        })
      )
    } catch (err) {
      return { ok: false, error: 'unreachable', detail: String(err) }
    }
    // 5xx is a blip; 4xx is Linear's definitive answer (bad code, spent refresh, rotated secret).
    if (!res.ok)
      return { ok: false, error: res.status >= 500 ? 'unreachable' : 'rejected', detail: `http ${res.status}` }
    const body = (await res.json().catch(() => undefined)) as TokenResponse | undefined
    if (!body || typeof body.access_token !== 'string' || !body.access_token) {
      return { ok: false, error: 'rejected', detail: 'token response carried no access token' }
    }
    const expiresInSec =
      typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : DEFAULT_EXPIRES_IN_SEC
    return {
      ok: true,
      result: {
        accessToken: body.access_token,
        refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : null,
        expiresAt: new Date(this.clock.now() + expiresInSec * 1000)
      }
    }
  }
}
