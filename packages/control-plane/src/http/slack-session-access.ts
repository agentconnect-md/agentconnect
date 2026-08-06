import { LRUCache } from 'lru-cache'
import type { FetchLike } from '../github/api.js'
import type { Clock } from '../domain/clock.js'
import type { BotRepo, BotSecretStore, ExternalScopeRecord } from '../persistence/ports.js'
import { BotId } from '../domain/ids.js'
import type { LogtoIdentityService } from '../github/logto-identity.js'
import type { SessionAccessPlugin, SessionAccessResult, SessionAccessViewer } from './session-access-plugin.js'

const ALLOW_TTL_MS = 120_000
const DENY_TTL_MS = 30_000
const UNKNOWN_TTL_MS = 5_000
const MAX_CACHE_ENTRIES = 10_000
const SCOPES_PER_BATCH = 200
const SCOPE_CONCURRENCY = 6
const MAX_MEMBER_PAGES = 50
const PAGE_SIZE = 200
const TIMEOUT_MS = 5_000
/**
 * How long one conversation's audience (public / members-only / gone) is reused.
 *
 * Like the repository shape on the GitHub side, the audience is a property of
 * the CONVERSATION, not of the viewer, while the decision cache below is keyed
 * per principal — so every viewer paid their own uncached `conversations.info`,
 * and for a public channel that call is the first half of every check. Reusing
 * it costs no lease: an `allow` expires this long after the audience was
 * OBSERVED, not after it was reused (see `putCache`).
 */
const AUDIENCE_TTL_MS = 120_000

/**
 * Shared `LRUCache` wiring.
 *
 * `perf` is THE time seam — without it the cache would read the wall clock
 * while everything around it reads the injected one. `ttlResolution: 0` turns
 * off lru-cache's 1 ms `now()` debounce, which is driven by a real timer a
 * `FakeClock` cannot advance; expiry is evaluated lazily on read, so no
 * background timer exists either way.
 *
 * The clock MUST report real epoch milliseconds, as `Clock` documents. lru-cache
 * stores an entry's start time and treats a falsy one as "no TTL recorded", so an
 * entry written at time 0 would never expire. Production passes `Date.now()`;
 * a test clock has to be seeded with an epoch rather than left at 0.
 */
function cacheOptions(clock: Clock) {
  return { max: MAX_CACHE_ENTRIES, ttlResolution: 0, perf: clock } as const
}

type Decision = 'allow' | 'deny' | 'unknown'
type ConversationAudience = 'public' | 'members' | 'gone' | 'unknown'
type WorkspaceAccess = 'allow' | 'membership' | 'deny' | 'unknown'
type SlackPrincipal = { key: string; teamId: string; userId: string }

type ObservedAudience = { audience: ConversationAudience; fetchedAt: number }
/** A verdict plus the age of the oldest evidence it rests on. */
type CheckedAccess = { decision: Decision; evidenceAt: number }
type AudienceLookup = { channel: string; token: string; signal: AbortSignal }

// `ok: false` covers two very different answers, and conflating them is what
// made an ordinary event — a private channel deleted, or the bot removed from
// it — report as a degraded access check. These codes are Slack ANSWERING: this
// credential cannot see that conversation / that user is not in the workspace.
// Nothing about a later retry changes them, so they are a plain deny (cached for
// DENY_TTL rather than re-asked every UNKNOWN_TTL). Everything else — auth,
// scope, rate limiting, outages, unrecognized codes, transport failures — is the
// CHECK failing, stays 'unknown', and is what `degraded` is for.
const DEFINITIVE_DENIALS = new Set([
  'channel_not_found',
  'not_in_channel',
  'user_not_found',
  'users_not_found',
  'user_not_visible'
])

function failureDecision(error: unknown): Decision {
  return typeof error === 'string' && DEFINITIVE_DENIALS.has(error) ? 'deny' : 'unknown'
}

function slackPrincipals(identitySet: ReadonlySet<string>): SlackPrincipal[] {
  const principals: SlackPrincipal[] = []
  for (const key of identitySet) {
    const match = /^slack:([^:]+):([^:]+)$/.exec(key)
    if (match) principals.push({ key, teamId: match[1]!, userId: match[2]! })
  }
  return principals
}

async function mapLimited<T, R>(values: readonly T[], limit: number, fn: (value: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(values.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (next < values.length) {
        const index = next++
        out[index] = await fn(values[index]!)
      }
    })
  )
  return out
}

/** Slack v1 current-access resolver. Public channels follow workspace access;
 * restricted conversations follow membership. Caches retain only bounded ACL
 * verdicts; linked identity remains request-local and provider-owned. */
export class SlackSessionAccessService implements SessionAccessPlugin {
  readonly provider = 'slack'
  /** Per-principal verdicts. Every entry carries its own TTL — see `putCache`. */
  private readonly cache: LRUCache<string, Decision>
  private readonly workspaceAccessCache: LRUCache<string, WorkspaceAccess>
  /** (bot, credential revision, channel) → audience. Shared across viewers,
   *  unlike `cache` and `workspaceAccessCache`, which are per principal.
   *  `fetch` hands concurrent callers of one key the same promise, and drops
   *  the entry when the call rejects. */
  private readonly audiences: LRUCache<string, ObservedAudience, AudienceLookup>

  constructor(
    private readonly deps: {
      bots: BotRepo
      botSecrets: BotSecretStore
      clock: Clock
      fetchImpl?: FetchLike
      identity?: Pick<LogtoIdentityService, 'slackIdentityFor'>
      /** Optional so tests can omit it. Without one a degraded check leaves NO
       *  trace anywhere: every failure below collapses to `unknown`, which is
       *  reported to the caller as a hidden session and to the operator as
       *  nothing at all — which is what made an intermittent Slack blip
       *  indistinguishable, after the fact, from a real authorization denial. */
      log?: { warn: (obj: object, msg: string) => void }
    }
  ) {
    this.cache = new LRUCache(cacheOptions(deps.clock))
    this.workspaceAccessCache = new LRUCache(cacheOptions(deps.clock))
    this.audiences = new LRUCache({
      ...cacheOptions(deps.clock),
      ttl: AUDIENCE_TTL_MS,
      fetchMethod: async (_key, _stale, { context }) => ({
        audience: await this.conversationAudience(context.channel, context.token, context.signal),
        fetchedAt: deps.clock.now()
      })
    })
  }

  get available(): boolean {
    return this.deps.identity !== undefined
  }

  async addViewerIdentities({ request, identitySet }: SessionAccessViewer): Promise<void> {
    const subject = request.oidcSubject
    if (!subject || !this.deps.identity) return
    const identity = await this.deps.identity.slackIdentityFor(subject)
    if (identity) identitySet.add(`slack:${identity.teamId}:${identity.userId}`)
  }

  async resolve(scopes: readonly ExternalScopeRecord[], viewer: SessionAccessViewer): Promise<SessionAccessResult> {
    const principals = slackPrincipals(viewer.identitySet)
    if (principals.length === 0 || scopes.length === 0) return { allowedScopes: [], degraded: false }
    let degraded = false
    const decisions: Array<{ scope: ExternalScopeRecord; decision: Decision }> = []
    // 200 is a provider-work batch, never a visibility ceiling. Walk every
    // batch so UUID ordering cannot silently hide an otherwise-allowed scope.
    for (let start = 0; start < scopes.length; start += SCOPES_PER_BATCH) {
      const signal = AbortSignal.timeout(TIMEOUT_MS)
      decisions.push(
        ...(await mapLimited(scopes.slice(start, start + SCOPES_PER_BATCH), SCOPE_CONCURRENCY, async (scope) => {
          const decision = await this.resolveScope(scope, principals, signal)
          if (decision === 'unknown') degraded = true
          return { scope, decision }
        }))
      )
    }
    // One line per degraded RESOLVE, not per scope: enough to correlate a user
    // reporting a vanished conversation with a Slack-side blip, without a log
    // entry per channel on a busy list. Counts only — a scope key names a
    // channel, and the operator needs the rate, not the targets.
    if (degraded) {
      this.deps.log?.warn(
        {
          provider: 'slack',
          unknownScopes: decisions.filter(({ decision }) => decision === 'unknown').length,
          totalScopes: decisions.length
        },
        'slack access check degraded — affected sessions are hidden until access can be verified'
      )
    }
    return {
      allowedScopes: decisions
        .filter(({ decision }) => decision === 'allow')
        .map(({ scope }) => ({ id: scope.id, aclRevision: scope.aclRevision })),
      degraded
    }
  }

  private async resolveScope(
    scope: ExternalScopeRecord,
    principals: readonly SlackPrincipal[],
    signal: AbortSignal
  ): Promise<Decision> {
    if (
      scope.provider !== 'slack' ||
      scope.resourceKind !== 'conversation' ||
      scope.revokedAt !== null ||
      scope.credentialKind !== 'bot' ||
      !scope.credentialId
    ) {
      return 'deny'
    }
    // The credential behind a session's recorded external scope — system state,
    // resolved without an org (org-scoped-data-layer.md §4). The scope row is
    // itself reached through the session, which the caller already fenced.
    const bot = await this.deps.bots.getUnscoped(BotId(scope.credentialId)).catch(() => null)
    const realm = bot?.workspaceId ?? bot?.teamId
    if (
      !bot ||
      bot.orgId !== scope.orgId ||
      bot.platform !== 'slack' ||
      bot.revokedAt !== null ||
      realm !== scope.realmKey
    ) {
      return 'unknown'
    }
    let sawUnknown = false
    for (const principal of principals) {
      const key = [scope.id, scope.aclRevision.toString(), bot.credentialRevision, principal.key].join(':')
      let decision = this.cache.get(key)
      if (!decision) {
        const checked = await this.checkAccess(scope, principal, bot.id, bot.credentialRevision, signal)
        decision = checked.decision
        this.putCache(key, decision, checked.evidenceAt)
      }
      if (decision === 'allow') return 'allow'
      if (decision === 'unknown') sawUnknown = true
    }
    return sawUnknown ? 'unknown' : 'deny'
  }

  private async checkAccess(
    scope: ExternalScopeRecord,
    principal: SlackPrincipal,
    botId: string,
    credentialRevision: number,
    signal: AbortSignal
  ): Promise<CheckedAccess> {
    const now = this.deps.clock.now()
    const secret = await this.deps.botSecrets.get(scope.orgId, BotId(botId)).catch(() => null)
    if (!secret?.botToken) return { decision: 'unknown', evidenceAt: now }
    try {
      const observed = await this.audienceOf(
        [botId, credentialRevision, scope.resourceKey].join(':'),
        scope.resourceKey,
        secret.botToken,
        signal
      )
      // Only reachable if the entry is dropped mid-flight; fail closed.
      if (!observed) return { decision: 'unknown', evidenceAt: now }
      const evidenceAt = observed.fetchedAt
      // The conversation is gone (or the bot is no longer in it): a settled fact
      // about the audience, not an unavailable check.
      if (observed.audience === 'gone') return { decision: 'deny', evidenceAt }
      if (observed.audience === 'unknown') return { decision: 'unknown', evidenceAt }
      if (observed.audience === 'public') {
        const access = await this.workspaceAccess(
          scope.realmKey,
          principal,
          credentialRevision,
          secret.botToken,
          signal
        )
        if (access !== 'membership') return { decision: access, evidenceAt }
        const member = await this.checkMembership(scope.resourceKey, principal.userId, secret.botToken, signal)
        return { decision: member, evidenceAt }
      }

      const member = await this.checkMembership(scope.resourceKey, principal.userId, secret.botToken, signal)
      if (member !== 'allow' || principal.teamId === scope.realmKey) return { decision: member, evidenceAt }

      // Slack Connect can return a member from another workspace. Verify the
      // identity's home team instead of treating the installing team as proof.
      const access = await this.workspaceAccess(scope.realmKey, principal, credentialRevision, secret.botToken, signal)
      return { decision: access === 'unknown' || access === 'deny' ? access : 'allow', evidenceAt }
    } catch {
      return { decision: 'unknown', evidenceAt: now }
    }
  }

  /** Cached + deduped conversation audience. */
  private async audienceOf(
    key: string,
    channel: string,
    token: string,
    signal: AbortSignal
  ): Promise<ObservedAudience | undefined> {
    const observed = await this.audiences.fetch(key, { context: { channel, token, signal } })
    // `unknown` is the CHECK failing, not an answer about the audience. Keeping
    // it would pin a transient Slack blip for two minutes; it stays a
    // per-request verdict, as it is everywhere else here.
    if (observed?.audience === 'unknown') this.audiences.delete(key)
    return observed
  }

  private async conversationAudience(
    channel: string,
    token: string,
    signal: AbortSignal
  ): Promise<ConversationAudience> {
    const body = await this.slackCall<{
      ok?: boolean
      error?: unknown
      channel?: { is_private?: unknown; is_im?: unknown; is_mpim?: unknown }
    }>(`conversations.info?channel=${encodeURIComponent(channel)}`, token, signal)
    if (!body.ok) return failureDecision(body.error) === 'deny' ? 'gone' : 'unknown'
    if (!body.channel) return 'unknown'
    if (body.channel.is_private === false && body.channel.is_im !== true && body.channel.is_mpim !== true) {
      return 'public'
    }
    if (body.channel.is_private === true || body.channel.is_im === true || body.channel.is_mpim === true) {
      return 'members'
    }
    return 'unknown'
  }

  private async workspaceAccess(
    realmKey: string,
    principal: SlackPrincipal,
    credentialRevision: number,
    token: string,
    signal: AbortSignal
  ): Promise<WorkspaceAccess> {
    const key = [realmKey, credentialRevision, principal.key].join(':')
    const cached = this.workspaceAccessCache.get(key)
    if (cached) return cached

    const body = await this.slackCall<{
      ok?: boolean
      error?: unknown
      user?: {
        team_id?: unknown
        profile?: { team?: unknown }
        enterprise_user?: { teams?: unknown }
        deleted?: unknown
        suspended?: unknown
        is_bot?: unknown
        is_profile_only_user?: unknown
        is_invited_user?: unknown
        is_restricted?: unknown
        is_ultra_restricted?: unknown
        is_stranger?: unknown
        is_external?: unknown
      }
    }>(`users.info?user=${encodeURIComponent(principal.userId)}`, token, signal)

    // A user Slack does not know in this workspace is a verdict, not an outage.
    let access: WorkspaceAccess = body.ok ? 'unknown' : failureDecision(body.error) === 'deny' ? 'deny' : 'unknown'
    if (body.ok && body.user) {
      const teams = new Set<string>()
      if (typeof body.user.team_id === 'string') teams.add(body.user.team_id)
      if (typeof body.user.profile?.team === 'string') teams.add(body.user.profile.team)
      if (Array.isArray(body.user.enterprise_user?.teams)) {
        for (const team of body.user.enterprise_user.teams) if (typeof team === 'string') teams.add(team)
      }
      if (
        !teams.has(principal.teamId) ||
        body.user.deleted === true ||
        body.user.suspended === true ||
        body.user.is_bot === true ||
        body.user.is_profile_only_user === true ||
        body.user.is_invited_user === true
      ) {
        access = 'deny'
      } else if (
        !teams.has(realmKey) ||
        body.user.is_restricted === true ||
        body.user.is_ultra_restricted === true ||
        body.user.is_stranger === true ||
        body.user.is_external === true
      ) {
        access = 'membership'
      } else {
        access = 'allow'
      }
    }
    this.putWorkspaceAccess(key, access)
    return access
  }

  private async checkMembership(
    channel: string,
    userId: string,
    token: string,
    signal: AbortSignal
  ): Promise<Decision> {
    let cursor = ''
    for (let page = 0; page < MAX_MEMBER_PAGES; page++) {
      const query = new URLSearchParams({ channel, limit: String(PAGE_SIZE) })
      if (cursor) query.set('cursor', cursor)
      const body = await this.slackCall<{
        ok?: boolean
        error?: unknown
        members?: unknown
        response_metadata?: { next_cursor?: unknown }
      }>(`conversations.members?${query}`, token, signal)
      if (!body.ok) return failureDecision(body.error)
      if (!Array.isArray(body.members)) return 'unknown'
      if (body.members.includes(userId)) return 'allow'
      cursor = typeof body.response_metadata?.next_cursor === 'string' ? body.response_metadata.next_cursor : ''
      if (!cursor) return 'deny'
      if (page === MAX_MEMBER_PAGES - 1) return 'unknown'
    }
    return 'unknown'
  }

  private async slackCall<T>(path: string, token: string, signal: AbortSignal): Promise<T> {
    const fetchImpl = this.deps.fetchImpl ?? (fetch as FetchLike)
    const response = await fetchImpl(`https://slack.com/api/${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal
    })
    if (!response.ok) throw new Error(`Slack request failed: ${response.status}`)
    return (await response.json()) as T
  }

  private putCache(key: string, decision: Decision, evidenceAt: number): void {
    const ttl = decision === 'allow' ? ALLOW_TTL_MS : decision === 'deny' ? DENY_TTL_MS : UNKNOWN_TTL_MS
    // An `allow` is leased from the EVIDENCE it rests on — `start` is the
    // observation, not the reuse — so serving a cached audience can never
    // stretch the window a fresh `conversations.info` would have granted.
    // `deny` and `unknown` run from now: reused evidence can only narrow
    // access, never widen it, so there is nothing to bound.
    const start = decision === 'allow' ? Math.min(evidenceAt, this.deps.clock.now()) : undefined
    this.cache.set(key, decision, { ttl, ...(start !== undefined ? { start } : {}) })
  }

  private putWorkspaceAccess(key: string, access: WorkspaceAccess): void {
    const ttl = access === 'allow' ? ALLOW_TTL_MS : access === 'unknown' ? UNKNOWN_TTL_MS : DENY_TTL_MS
    this.workspaceAccessCache.set(key, access, { ttl })
  }
}
