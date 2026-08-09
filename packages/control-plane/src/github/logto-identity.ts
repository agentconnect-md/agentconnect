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
 * Caching: the M2M token until 60s before expiry; display/GitHub projections
 * keep a 10 min positive / 60 s negative user cache, while provider authorization
 * caps reuse of a positive assertion at 2 min. A hit past half of the lease it
 * ran under also renews the entry in the background (refresh-ahead), so an
 * entry read at least once per half-lease never ages into a blocking refetch —
 * the leases themselves stay hard for first-ever and idle-return reads.
 * Lookups are single-flight and fail CLOSED at their authorization callers.
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

/** Credentials enable the feature; an endpoint alone is topology-only. */
export function resolveLogtoMgmtConfig(env: {
  LOGTO_MGMT_ENDPOINT?: string
  LOGTO_MGMT_APP_ID?: string
  LOGTO_MGMT_APP_SECRET?: string
  LOGTO_MGMT_RESOURCE?: string
}): LogtoMgmtConfig | undefined {
  const { LOGTO_MGMT_ENDPOINT, LOGTO_MGMT_APP_ID, LOGTO_MGMT_APP_SECRET } = env
  if (!LOGTO_MGMT_APP_ID && !LOGTO_MGMT_APP_SECRET) return undefined
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
// Provider identity participates in live Session authorization. Even if no
// in-product unlink invalidation fires (for example an administrator changes
// the Logto account directly), a positive assertion is never reused beyond
// this hard lease. Exported so callers holding provider identity evidence of
// their own (the GitHub session-access login leg) can join the same lease
// instead of inventing a second number.
export const PROVIDER_IDENTITY_TTL_MS = 120_000
// Bounds the BLOCKING lookups (first-ever read, idle return past a lease) —
// refresh-ahead keeps actively-read entries off that path, so a hung upstream
// can pin a request for at most this long, and only a cold one.
const TIMEOUT_MS = 5_000
// How long a target's link mode is trusted. Short enough that a Logto upgrade
// which fixes a connector is picked up the same day, long enough that the probe
// is not per click.
const LINK_MODE_TTL_MS = 60 * 60_000

interface CachedLogin {
  login: string | null
  fetchedAt: number
  expiresAt: number
}

interface CachedUser {
  user: LogtoUser | null
  fetchedAt: number
  expiresAt: number
}

/**
 * Should a hit that satisfied its caller also renew the entry in the
 * background? Yes once the entry is past HALF the lease the read ran under —
 * the tighter of the entry's own window (positive or negative TTL) and the
 * caller's `maxAgeMs` cap. E.g. a provider-identity read (120 s cap) starts
 * refreshing at 60 s, so a subject read at least once a minute never ages out.
 * Strictly greater than: at exactly half the lease the hit is still quiet.
 */
function refreshAheadDue(cached: { fetchedAt: number; expiresAt: number }, now: number, maxAgeMs?: number): boolean {
  const leaseMs = Math.min(cached.expiresAt - cached.fetchedAt, maxAgeMs ?? Number.POSITIVE_INFINITY)
  return now - cached.fetchedAt > leaseMs / 2
}

/** One linked sign-in method, narrowed to what the Profile card renders. The
 *  connector's `rawData` is deliberately NOT part of this: it is a whole OIDC
 *  payload, and none of it needs to reach a browser. */
export interface SocialIdentitySummary {
  target: string
  userId: string
  name?: string
  email?: string
  avatar?: string
  /** Where this account lives at its provider, when that is addressable. */
  profileUrl?: string
  /** Slack only — the workspace it belongs to. */
  workspace?: { teamId: string; name?: string; domain?: string; url?: string }
}

/** Everything the Profile card needs about an account's sign-in methods. */
export interface SocialAccount {
  identities: SocialIdentitySummary[]
  /** Logto refuses an identity change the caller has not re-proven whenever
   *  this holds, so the console has to collect a code first. Mirrors Logto's own
   *  rule: a password, an email, or a phone. */
  hasSecurityVerificationMethod: boolean
  primaryEmail?: string
}

/**
 * The Slack workspace identity behind a console account. Both ids are required —
 * a `U…` without its `T…` is not addressable, so a partial read is no read.
 *
 * IDENTIFY A SLACK HUMAN BY THE PAIR, NOT BY `userId` ALONE. Slack's Web API
 * documents the user id as workspace-scoped and says to store it together with
 * the team id, and Enterprise Grid can give one person more than one id. Taking
 * just `userId` off this type compiles, reads naturally, and drops the qualifier
 * Slack asks you to keep. See docs/designs/slack-identity.md for what this does
 * and does NOT claim about the OIDC `sub`.
 */
export interface SlackIdentity {
  /** Slack workspace id (`T…`). */
  teamId: string
  /** Slack user id (`U…`) — scoped to that workspace, NOT globally unique. */
  userId: string
  teamName?: string
  teamDomain?: string
}

export interface FeishuIdentity {
  region: 'feishu' | 'lark'
  /** Developer-organization-scoped human identity. Custom apps created by the
   * same Lark/Feishu tenant report the same value for this person. */
  unionId: string
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

/** The Logto user shape we read — identity metadata plus the three fields
 *  Logto's own `hasSecurityVerificationMethod` is computed from. */
interface LogtoUser {
  primaryEmail?: unknown
  primaryPhone?: unknown
  hasPassword?: unknown
  identities?: Record<
    string,
    {
      userId?: string
      details?: {
        name?: unknown
        email?: unknown
        avatar?: unknown
        // The connector's raw profile. Logto's github connector stores the
        // GitHub /user response under `rawData` (login at `userInfo.login` on
        // current connectors; older ones kept the flat `login`); the slack
        // connector stores the whole decoded OIDC payload there.
        rawData?: { userInfo?: { login?: unknown }; login?: unknown } & Record<string, unknown>
      }
    }
  >
}

/**
 * How a link must be driven for one provider.
 *
 *  - `direct`  — Logto built the authorization URI for us, so the whole link
 *    runs server-side on the Management API. Nothing needs the end user to
 *    re-prove anything: the M2M credential is the authority.
 *  - `verified` — that connector cannot be driven without a session (it stores
 *    state while building the URI), so the browser must drive it against the
 *    Account API, where the user's own token is the authority and Logto demands
 *    an ownership proof.
 *
 * Decided by ASKING Logto rather than from a list of provider names: Logto's
 * own published list omitted Slack, and a wrong guess here is the 502 that
 * linking Slack used to be.
 */
export type SocialLinkMode = 'direct' | 'verified'

export type SocialAuthorization =
  { mode: 'direct'; connectorId: string; authorizationUri: string } | { mode: 'verified'; connectorId: string }

interface CachedLinkMode {
  mode: SocialLinkMode
  expiresAt: number
}

export class LogtoIdentityService {
  private token?: { value: string; expiresAt: number }
  private tokenInFlight?: Promise<string>
  private readonly logins = new Map<string, CachedLogin>()
  private readonly loginInFlight = new Map<string, Promise<string | null>>()
  // One cache for every display-only read, so a Profile load costs ONE upstream
  // fetch rather than one per projection. Kept separate from the login cache on
  // purpose: githubLoginFor sits on a live authorization gate, and display reads
  // must not be able to shift what that gate sees (or when it re-asks).
  // Which way each target must be linked. Cached because the answer is a
  // property of the connector, not of the user, and probing costs a round trip.
  private readonly linkModes = new Map<string, CachedLinkMode>()
  private readonly users = new Map<string, CachedUser>()
  private readonly userInFlight = new Map<string, Promise<LogtoUser | null>>()
  // Invalidation fence. `slackIdentityFor` feeds an authorization decision
  // (the session-visibility identity set), so an invalidation must be FINAL:
  // deleting the settled entries alone leaves a race where a read that BEGAN
  // before an unlink settles after it and writes the removed identity back for
  // its full TTL. Every invalidation bumps the subject's epoch; a lookup only
  // caches its result if the epoch it started under is still current.
  private readonly cacheEpochs = new Map<string, number>()

  constructor(
    private readonly cfg: LogtoMgmtConfig,
    private readonly clock: Clock,
    private readonly mutations: SocialIdentityMutationGate,
    private readonly fetchImpl: FetchLike = fetch as FetchLike,
    private readonly log?: { debug(obj: object, msg: string): void; info(obj: object, msg: string): void }
  ) {}

  /**
   * The GitHub login behind a local user's OIDC subject, or null when the
   * account has no GitHub identity (e.g. Google sign-in) — callers map null to
   * a GITHUB_IDENTITY_REQUIRED denial, never a silent allow.
   */
  async githubLoginFor(sub: string, maxAgeMs?: number): Promise<string | null> {
    const cached = this.logins.get(sub)
    const now = this.clock.now()
    if (cached && cached.expiresAt > now && (maxAgeMs === undefined || now - cached.fetchedAt < maxAgeMs)) {
      if (refreshAheadDue(cached, now, maxAgeMs)) this.refreshInBackground(sub, () => this.pendingLogin(sub))
      return cached.login
    }
    this.noteColdBlock('logins', sub, maxAgeMs, this.loginInFlight.has(sub))
    return this.pendingLogin(sub)
  }

  /** The deduped in-flight login lookup — one upstream read serves every
   *  concurrent caller, blocking miss and refresh-ahead alike. */
  private pendingLogin(sub: string): Promise<string | null> {
    let pending = this.loginInFlight.get(sub)
    if (!pending) {
      const tracked: Promise<string | null> = this.lookupLogin(sub).finally(() => {
        // Only clear our own registration — an invalidation may have replaced it
        // with a fresh in-flight read that must keep de-duplicating.
        if (this.loginInFlight.get(sub) === tracked) this.loginInFlight.delete(sub)
      })
      pending = tracked
      this.loginInFlight.set(sub, pending)
    }
    return pending
  }

  /**
   * The Slack workspace identity behind a local user's OIDC subject, or null
   * when the account never signed in with (or linked) Slack.
   *
   * This IS an identity assertion: the record exists in Logto only after a
   * Slack OIDC sign-in, or an Account API link driven by the user's own
   * authenticated session — so the session-visibility identity set
   * (the Slack Session-access plugin) may match it against `ownerIdentity`. It is
   * NOT an org/role statement: callers still compose it with org scoping.
   * Served from the shared user cache; a just-landed link is surfaced by the
   * console's refresh call (`forgetUser`).
   */
  async slackIdentityFor(sub: string): Promise<SlackIdentity | null> {
    return slackIdentityOf(await this.logtoUser(sub, PROVIDER_IDENTITY_TTL_MS))
  }

  /** Linked Feishu/Lark identities, keyed by the provider's cross-app union_id. */
  async feishuIdentitiesFor(sub: string): Promise<FeishuIdentity[]> {
    return feishuIdentitiesOf(await this.logtoUser(sub, PROVIDER_IDENTITY_TTL_MS))
  }

  /**
   * Warm-at-touch trigger (session-access-cold-visit.md §3): start, fire-and-forget,
   * the background lookups a later authorization read of this subject would block on.
   * Gated on the same dueness those reads apply (missing / expired against the 120 s
   * cap / past its half-lease, nothing already in flight) so the debug line counts
   * actual upstream fires. Rides the shared single-flight lookups and the epoch fence
   * unchanged; the 120 s lease is untouched — this adds a trigger, not a serving rule.
   */
  ensureIdentityFresh(sub: string): void {
    const now = this.clock.now()
    const due = (cached: { fetchedAt: number; expiresAt: number } | undefined) =>
      !cached ||
      cached.expiresAt <= now ||
      now - cached.fetchedAt >= PROVIDER_IDENTITY_TTL_MS ||
      refreshAheadDue(cached, now, PROVIDER_IDENTITY_TTL_MS)
    const users = due(this.users.get(sub)) && !this.userInFlight.has(sub)
    const logins = due(this.logins.get(sub)) && !this.loginInFlight.has(sub)
    if (users) this.refreshInBackground(sub, () => this.pendingUser(sub))
    if (logins) this.refreshInBackground(sub, () => this.pendingLogin(sub))
    if (users || logins) this.log?.debug({ sub, users, logins }, 'logto identity warm-ahead fired')
  }

  /**
   * The account's sign-in methods, narrowed for display. Serving this from here
   * rather than letting the browser call Logto directly is the point: the
   * upstream read is cached and made from a process that sits next to Logto,
   * instead of once per page load from wherever the user happens to be.
   */
  async socialAccountFor(sub: string): Promise<SocialAccount> {
    const user = await this.logtoUser(sub)
    if (!user) return { identities: [], hasSecurityVerificationMethod: false }
    const slack = slackIdentityOf(user)
    const identities = Object.entries(user.identities ?? {}).map(([target, identity]) =>
      summarize(target, identity, target === 'slack' ? slack : null)
    )
    const primaryEmail = firstString(user.primaryEmail)
    return {
      identities,
      // Logto's own rule (core/routes/account): a password, an email, or a phone.
      hasSecurityVerificationMethod: Boolean(user.hasPassword) || Boolean(primaryEmail) || Boolean(user.primaryPhone),
      ...(primaryEmail ? { primaryEmail } : {})
    }
  }

  /**
   * Drop the cached user because it was changed somewhere this service cannot
   * see. Linking runs browser→Logto — the Account API is the only side with a
   * connector session — so the write never passes through here, and without
   * this the positive cache would hide a just-linked identity for its full TTL.
   * Fenced like {@link invalidate}: an in-flight read from before the change
   * may finish after it and must not write the pre-change user back.
   */
  forgetUser(sub: string): void {
    this.bumpEpoch(sub)
    this.users.delete(sub)
    this.userInFlight.delete(sub)
  }

  /** The cached upstream user every display read projects from. */
  private async logtoUser(sub: string, maxAgeMs?: number): Promise<LogtoUser | null> {
    const cached = this.users.get(sub)
    const now = this.clock.now()
    if (cached && cached.expiresAt > now && (maxAgeMs === undefined || now - cached.fetchedAt < maxAgeMs)) {
      if (refreshAheadDue(cached, now, maxAgeMs)) this.refreshInBackground(sub, () => this.pendingUser(sub))
      return cached.user
    }
    this.noteColdBlock('users', sub, maxAgeMs, this.userInFlight.has(sub))
    return this.pendingUser(sub)
  }

  // Cold-block counter (session-access-cold-visit.md §5): an authorization-lease read
  // (`maxAgeMs` set — display reads pass none) found neither a servable entry nor an
  // in-flight lookup to join, so the caller stalls on Logto. The rate of this line is
  // the number the §3 warm trigger exists to drive to ~zero for console traffic.
  private noteColdBlock(cache: 'users' | 'logins', sub: string, maxAgeMs: number | undefined, inFlight: boolean): void {
    if (maxAgeMs !== undefined && !inFlight) this.log?.info({ sub, cache }, 'logto identity blocking fetch')
  }

  /** The deduped in-flight user lookup — one upstream read serves every
   *  concurrent caller, blocking miss and refresh-ahead alike. */
  private pendingUser(sub: string): Promise<LogtoUser | null> {
    let pending = this.userInFlight.get(sub)
    if (!pending) {
      const tracked: Promise<LogtoUser | null> = this.lookupUser(sub).finally(() => {
        // Only clear our own registration — an invalidation may have replaced it
        // with a fresh in-flight read that must keep de-duplicating.
        if (this.userInFlight.get(sub) === tracked) this.userInFlight.delete(sub)
      })
      pending = tracked
      this.userInFlight.set(sub, pending)
    }
    return pending
  }

  /**
   * Fire-and-forget renewal behind a served cache hit. Routed through the same
   * in-flight dedupe as a blocking miss (concurrent triggers coalesce onto one
   * fetch) and through the same epoch-checked lookups (a refresh in flight
   * across an invalidation is returned to nobody and never cached). A failure
   * is only debug-logged: the entry it would have replaced is still within its
   * lease, and once that runs out the blocking path surfaces the same error to
   * a caller that can act on it.
   */
  private refreshInBackground(sub: string, lookup: () => Promise<unknown>): void {
    void lookup().catch((err: unknown) => this.log?.debug({ err, sub }, 'logto refresh-ahead lookup failed'))
  }

  /**
   * The tenant's Social connector id for a provider target.
   *
   * Resolution only — building the authorization URI is deliberately NOT done
   * here. Logto's `POST /api/connectors/:id/authorization-uri` runs the
   * connector with no session context (it passes `notImplemented` as the
   * session store), so any connector whose `getAuthorizationUri` persists state
   * — Slack stores `redirectUri` there, and Apple / standard OIDC / OAuth 2.0
   * do the same — fails inside Logto with a 500. The browser drives the
   * authorization through the Account API instead, where the verification
   * record carries that session; it only needs this id to start.
   */
  async socialConnectorIdFor(target: string): Promise<string> {
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
    return connectorId
  }

  /**
   * Start a link: resolve the connector, then find out whether Logto will build
   * its authorization URI for us.
   *
   * A failure here is NOT reported as one. Every connector that cannot be
   * driven server-side is still linkable through the browser, so the answer to
   * "Logto refused" is `verified` — the caller falls back and the user gets a
   * working link, just with an ownership check in front of it.
   */
  async socialAuthorizationFor(target: string, redirectUri: string, state: string): Promise<SocialAuthorization> {
    const connectorId = await this.socialConnectorIdFor(target)
    const cached = this.linkModes.get(target)
    if (cached && cached.expiresAt > this.clock.now() && cached.mode === 'verified') {
      return { mode: 'verified', connectorId }
    }

    let authorizationUri: string | undefined
    try {
      const res = await this.request(`/api/connectors/${encodeURIComponent(connectorId)}/authorization-uri`, {
        method: 'POST',
        body: JSON.stringify({ redirectUri, state })
      })
      if (res.ok) {
        const body = (await res.json()) as { redirectTo?: unknown }
        if (typeof body.redirectTo === 'string' && body.redirectTo.length > 0) authorizationUri = body.redirectTo
      }
    } catch {
      // Unreachable upstream is indistinguishable from an unsupported connector
      // here, and both have the same safe answer: drive it from the browser.
    }

    const mode: SocialLinkMode = authorizationUri ? 'direct' : 'verified'
    this.linkModes.set(target, { mode, expiresAt: this.clock.now() + LINK_MODE_TTL_MS })
    return authorizationUri ? { mode: 'direct', connectorId, authorizationUri } : { mode: 'verified', connectorId }
  }

  /** Link the provider identity proved by `connectorData`, server-side. Only
   *  valid for a target that answered `direct`; a session-bound connector fails
   *  here for the same reason it could not build its URI. */
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
   *  Profile does not keep showing a method the user just changed — and, fenced,
   *  so an unlinked identity cannot survive as an authorization grant. */
  private invalidate(sub: string): void {
    this.bumpEpoch(sub)
    this.logins.delete(sub)
    this.loginInFlight.delete(sub)
    this.users.delete(sub)
    this.userInFlight.delete(sub)
  }

  private epochOf(sub: string): number {
    return this.cacheEpochs.get(sub) ?? 0
  }

  private bumpEpoch(sub: string): void {
    this.cacheEpochs.set(sub, this.epochOf(sub) + 1)
  }

  private async lookupUser(sub: string): Promise<LogtoUser | null> {
    const epoch = this.epochOf(sub)
    const res = await this.request(`/api/users/${encodeURIComponent(sub)}`)
    // A result older than the last invalidation is returned to ITS caller (that
    // read began before the change) but never cached — the fence.
    const current = () => this.epochOf(sub) === epoch
    if (res.status === 404) {
      // Deleted at the provider — cache the miss briefly.
      if (current()) {
        const fetchedAt = this.clock.now()
        this.users.set(sub, { user: null, fetchedAt, expiresAt: fetchedAt + NEGATIVE_TTL_MS })
      }
      return null
    }
    if (!res.ok) {
      throw new LogtoApiError(`logto user lookup failed: ${res.status}`, res.status, res.status >= 500)
    }
    const user = (await res.json()) as LogtoUser
    if (current()) {
      const fetchedAt = this.clock.now()
      this.users.set(sub, { user, fetchedAt, expiresAt: fetchedAt + LOGIN_TTL_MS })
    }
    return user
  }

  private async lookupLogin(sub: string): Promise<string | null> {
    const epoch = this.epochOf(sub)
    const res = await this.request(`/api/users/${encodeURIComponent(sub)}`)
    const current = () => this.epochOf(sub) === epoch
    if (res.status === 404) {
      // Deleted at the provider — no identity, cache the miss briefly.
      if (current()) {
        const fetchedAt = this.clock.now()
        this.logins.set(sub, { login: null, fetchedAt, expiresAt: fetchedAt + NEGATIVE_TTL_MS })
      }
      return null
    }
    if (!res.ok) {
      throw new LogtoApiError(`logto user lookup failed: ${res.status}`, res.status, res.status >= 500)
    }
    const user = (await res.json()) as LogtoUser
    const raw = user.identities?.github?.details?.rawData
    const login = firstString(raw?.userInfo?.login, raw?.login)
    if (current()) {
      const fetchedAt = this.clock.now()
      this.logins.set(sub, {
        login,
        fetchedAt,
        expiresAt: fetchedAt + (login ? LOGIN_TTL_MS : NEGATIVE_TTL_MS)
      })
    }
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

/**
 * Where a linked account lives at its provider. Built from the connector's
 * stored `rawData`, a snapshot from sign-in — a renamed workspace yields a
 * stale link, so nothing may depend on one resolving. Google has no per-person
 * public profile, so it points at the page its owner can actually act on.
 */
function providerProfileUrl(target: string, raw: Record<string, unknown>, slack: SlackIdentity | null): string | null {
  if (target === 'github') {
    const userInfo = (raw.userInfo ?? {}) as { login?: unknown }
    const login = firstString(userInfo.login, raw.login)
    return login ? `https://github.com/${encodeURIComponent(login)}` : null
  }
  if (target === 'slack') {
    return slack?.teamDomain ? `https://${slack.teamDomain}.slack.com/team/${encodeURIComponent(slack.userId)}` : null
  }
  if (target === 'google') return 'https://myaccount.google.com/profile'
  return null
}

/** Narrow one linked identity to what a Profile row renders. */
function summarize(
  target: string,
  identity: NonNullable<LogtoUser['identities']>[string],
  slack: SlackIdentity | null
): SocialIdentitySummary {
  const details = identity.details ?? {}
  const raw = (details.rawData ?? {}) as Record<string, unknown>
  const name = firstString(details.name)
  const email = firstString(details.email)
  // Not every connector fills the normalized `avatar`: Logto stores it for
  // github and google but not for slack, whose picture survives only as the
  // `picture` claim inside the raw payload. Falling back to it costs nothing
  // and is what any OIDC connector carries.
  const avatar = firstString(details.avatar, raw.picture)
  const profileUrl = providerProfileUrl(target, raw, slack)
  const workspace = slack
    ? {
        teamId: slack.teamId,
        ...(slack.teamName ? { name: slack.teamName } : {}),
        ...(slack.teamDomain ? { domain: slack.teamDomain, url: `https://${slack.teamDomain}.slack.com` } : {})
      }
    : undefined
  return {
    target,
    userId: identity.userId ?? '',
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...(avatar ? { avatar } : {}),
    ...(profileUrl ? { profileUrl } : {}),
    ...(workspace ? { workspace } : {})
  }
}

/** Read the Slack workspace identity out of a Logto user, or null when the
 *  account has no usable one. */
function slackIdentityOf(user: LogtoUser | null): SlackIdentity | null {
  const identity = user?.identities?.slack
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

function feishuIdentitiesOf(user: LogtoUser | null): FeishuIdentity[] {
  const identities: FeishuIdentity[] = []
  for (const region of ['feishu', 'lark'] as const) {
    const identity = user?.identities?.[region]
    const raw = identity?.details?.rawData
    const data = raw?.data as Record<string, unknown> | undefined
    const userInfo = raw?.userInfo as Record<string, unknown> | undefined
    // The stock Logto connector stores Feishu's app-scoped `sub`/`open_id` as
    // `userId`; only the explicit provider field is safe to treat as union_id.
    const unionId = firstString(raw?.union_id, data?.union_id, userInfo?.union_id)
    if (unionId) identities.push({ region, unionId })
  }
  return identities
}
