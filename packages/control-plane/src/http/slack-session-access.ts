import { LRUCache } from 'lru-cache'
import { cacheOptions } from '../cache.js'
import type { FetchLike } from '../github/api.js'
import type { Clock } from '../domain/clock.js'
import type { BotRepo, BotSecretStore, ExternalScopeRecord } from '../persistence/ports.js'
import { BotId } from '../domain/ids.js'
import type { LogtoIdentityService } from '../github/logto-identity.js'
import type {
  SessionAccessIssue,
  SessionAccessPlugin,
  SessionAccessResult,
  SessionAccessViewer
} from './session-access-plugin.js'

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

type Decision = 'allow' | 'deny' | 'unknown'
type ConversationAudience = 'public' | 'members' | 'gone' | 'unknown'
type WorkspaceAccess = 'allow' | 'membership' | 'deny' | 'unknown'
type SlackPrincipal = { key: string; teamId: string; userId: string }

/**
 * Why a check could not answer, as one low-cardinality label.
 *
 * Slack refuses over HTTP 200 with `ok: false`, so `body.error` is the only
 * thing separating `missing_scope` from `ratelimited` from an outage — and
 * every reader below used to drop it, leaving the warn in `resolve` reporting a
 * rate with no cause. The reason rides along with the verdict instead, so that
 * one line can name it.
 *
 * A reason is a CAUSE, never a TARGET: Slack's own code, or a `LocalReason`.
 * Nothing derived from a channel, conversation, user, team, or scope may become
 * one — `slackErrorReason` holds the provider half of that line.
 */
type DegradedReason = string

/**
 * The failures this file names itself, as against the ones Slack names. They
 * cannot be read as a Slack code: Slack has no `bot_*`, no `*_unclassified`,
 * no `request_*`, and no `http_*`.
 *
 * One union keeps the vocabulary an operator greps for in one block, and
 * `unresolved` takes it, so the labels raised here are checked rather than
 * free strings.
 */
type LocalReason =
  | 'bot_unresolved'
  | 'bot_token_missing'
  /** The shared audience entry was dropped while this caller was reading it. */
  | 'audience_evicted'
  /** Slack answered, in a shape no verdict can be read out of. */
  | 'audience_unclassified'
  | 'user_unclassified'
  | 'members_unclassified'
  | 'member_pages_exhausted'
  /** `ok: false` carrying something outside Slack's own error vocabulary. */
  | 'unrecognized_error'
  | 'request_timeout'
  | 'request_aborted'
  | 'transport_failure'
  | `http_${number}`

/** A verdict, plus — when it is `unknown` — why the check could not answer. */
type Verdict = { decision: Decision; reason?: DegradedReason }
/** Slack answered `ok: false`: a definitive denial, or a check that could not
 *  run and the code Slack gave for it. */
type FailureVerdict = { decision: 'deny' } | { decision: 'unknown'; reason: DegradedReason }
/** What one `conversations.info` said. */
type ReadAudience =
  | { audience: Exclude<ConversationAudience, 'unknown'>; reason?: undefined }
  | { audience: 'unknown'; reason: DegradedReason }
type ObservedAudience = ReadAudience & { fetchedAt: number }
/** A verdict plus the age of the oldest evidence it rests on. */
type CheckedAccess = Verdict & { evidenceAt: number }
type CheckedWorkspaceAccess = { access: WorkspaceAccess; reason?: DegradedReason }
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

/**
 * Slack's error vocabulary is lowercase snake_case words. Every Slack object id
 * — channel, conversation, user, team, enterprise, app — is uppercase-prefixed,
 * and an address carries `@`, so this shape check is not decoration: it is what
 * stops an unexpected `error` payload from turning the warn in `resolve` into
 * somewhere a channel could be named. Anything that is not one of Slack's own
 * words is reported as its shape and its content dropped.
 */
const SLACK_ERROR_CODE = /^[a-z][a-z0-9_]{0,47}$/

function slackErrorReason(error: unknown): DegradedReason {
  return typeof error === 'string' && SLACK_ERROR_CODE.test(error) ? error : 'unrecognized_error'
}

/** `failureDecision`, carrying the code Slack gave when the answer was that the
 *  check could not run. Which codes are a definitive denial is unchanged. */
function failureVerdict(error: unknown): FailureVerdict {
  return failureDecision(error) === 'deny'
    ? { decision: 'deny' }
    : { decision: 'unknown', reason: slackErrorReason(error) }
}

/** An `unknown` this file raises on its own behalf. Going through one
 *  constructor is what makes the label a checked `LocalReason`; the other
 *  `unknown`s relay a code Slack gave. */
function unresolved(reason: LocalReason): { decision: 'unknown'; reason: DegradedReason } {
  return { decision: 'unknown', reason }
}

/** Carries a reason across the throw, so the catch in `checkAccess` can report
 *  which failure it caught rather than one undifferentiated bucket. */
class SlackCallFailed extends Error {
  constructor(readonly reason: LocalReason) {
    super(`Slack request failed: ${reason}`)
    this.name = 'SlackCallFailed'
  }
}

function thrownReason(error: unknown): LocalReason {
  if (error instanceof SlackCallFailed) return error.reason
  if (!(error instanceof Error)) return 'transport_failure'
  // `AbortSignal.timeout` surfaces as a TimeoutError — directly, or as the
  // `cause` of the AbortError `fetch` rejects with. Worth separating from a
  // plain abort: one says the batch ran out of its budget, the other that
  // something cancelled the request.
  const cause = error.cause instanceof Error ? error.cause.name : ''
  if (error.name === 'TimeoutError' || cause === 'TimeoutError') return 'request_timeout'
  return error.name === 'AbortError' ? 'request_aborted' : 'transport_failure'
}

/**
 * The refusals that mean the INSTALLED APP's authorization is what failed — as
 * opposed to Slack being unreachable, slow, or rate limiting.
 *
 * The distinction is the whole point of `app_authorization`: everything in here
 * is fixed once, by an administrator, through the app's own row on Integrations
 * (`POST /bots/:id/slack/refresh` syncs the manifest and names the missing
 * scopes), and nothing in here clears on its own. `missing_scope` is the
 * observed case — an app installed before a scope was added to
 * `SLACK_BOT_SCOPES` keeps a grant that can never pass the check — and the rest
 * are the other ways Slack says "this credential is the problem", which land on
 * the same page and the same button.
 *
 * Deliberately NOT here: `ratelimited` and every transport/HTTP failure, which
 * really are transient; and `ekm_access_denied`, which is an enterprise key
 * policy that reauthorizing the app cannot lift. Those stay `unavailable`.
 */
const APP_AUTHORIZATION_ERRORS = new Set([
  'missing_scope',
  'invalid_auth',
  'account_inactive',
  'token_revoked',
  'token_expired',
  'no_permission'
])

/**
 * One degraded scope's cause, projected onto the console's vocabulary.
 *
 * The projection is deliberately lossy. `DegradedReason` is an operator-facing
 * label — Slack's own word, or a `LocalReason` — and it stays in the log; what
 * crosses into `accessIssues` is only which REMEDY the reason implies, so a
 * member sees "reauthorize the app" or "try again later" and never a code they
 * would have to look up. It carries no bot, workspace, or channel: see
 * `SessionAccessIssue`.
 */
function accessIssueFor(reason: DegradedReason): SessionAccessIssue {
  return { provider: 'slack', reason: APP_AUTHORIZATION_ERRORS.has(reason) ? 'app_authorization' : 'unavailable' }
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
  /** Per-principal verdicts. Every entry carries its own TTL — see `putCache`.
   *  A cached `unknown` keeps the reason it was reached by, so a resolve that
   *  rides one is not the one degraded resolve that cannot say why. */
  private readonly cache: LRUCache<string, Verdict>
  private readonly workspaceAccessCache: LRUCache<string, CheckedWorkspaceAccess>
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
    this.cache = new LRUCache(cacheOptions(deps.clock, MAX_CACHE_ENTRIES))
    this.workspaceAccessCache = new LRUCache(cacheOptions(deps.clock, MAX_CACHE_ENTRIES))
    this.audiences = new LRUCache({
      ...cacheOptions(deps.clock, MAX_CACHE_ENTRIES),
      ttl: AUDIENCE_TTL_MS,
      fetchMethod: async (_key, _stale, { context }) => ({
        ...(await this.conversationAudience(context.channel, context.token, context.signal)),
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
    if (principals.length === 0 || scopes.length === 0) {
      return { allowedScopes: [], degraded: false, accessIssues: [] }
    }
    let degraded = false
    const decisions: Array<{ scope: ExternalScopeRecord; verdict: Verdict }> = []
    // 200 is a provider-work batch, never a visibility ceiling. Walk every
    // batch so UUID ordering cannot silently hide an otherwise-allowed scope.
    for (let start = 0; start < scopes.length; start += SCOPES_PER_BATCH) {
      const signal = AbortSignal.timeout(TIMEOUT_MS)
      decisions.push(
        ...(await mapLimited(scopes.slice(start, start + SCOPES_PER_BATCH), SCOPE_CONCURRENCY, async (scope) => {
          const verdict = await this.resolveScope(scope, principals, signal)
          if (verdict.decision === 'unknown') degraded = true
          return { scope, verdict }
        }))
      )
    }
    // One line per degraded RESOLVE, not per scope: enough to correlate a user
    // reporting a vanished conversation with a Slack-side blip, without a log
    // entry per channel on a busy list. Counts and causes only — a scope key
    // names a channel, and the operator needs the rate and the reason, not the
    // targets. So `reasons` aggregates by CODE — Slack's own word for the
    // refusal, or a `LocalReason` — and never by conversation: one bucket may
    // cover many channels, but no bucket can name one. Its counts sum to
    // `unknownScopes`, since a scope reports the first cause that hid it.
    //
    // The SAME walk feeds `accessIssues`, which is the requester-facing half of
    // the diagnosis and the reason a degraded Slack check used to reach the
    // console as a bare boolean. Two audiences, two vocabularies, one pass: the
    // operator gets the codes and their counts, the member gets the remedy those
    // codes imply and nothing else — at most one issue per remedy, because a
    // reason is a cause and there is no per-scope axis to spread them over.
    const accessIssues = new Map<SessionAccessIssue['reason'], SessionAccessIssue>()
    if (degraded) {
      const reasons = new Map<DegradedReason, number>()
      let unknownScopes = 0
      for (const { verdict } of decisions) {
        if (verdict.decision !== 'unknown') continue
        unknownScopes += 1
        // `unreported` cannot be reached today — every `unknown` below names a
        // cause — and is what a future path that forgot to would look like.
        const reason = verdict.reason ?? 'unreported'
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
        const issue = accessIssueFor(reason)
        accessIssues.set(issue.reason, issue)
      }
      this.deps.log?.warn(
        { provider: 'slack', unknownScopes, totalScopes: decisions.length, reasons: Object.fromEntries(reasons) },
        'slack access check degraded — affected sessions are hidden until access can be verified'
      )
    }
    return {
      allowedScopes: decisions
        .filter(({ verdict }) => verdict.decision === 'allow')
        .map(({ scope }) => ({ id: scope.id, aclRevision: scope.aclRevision })),
      degraded,
      accessIssues: [...accessIssues.values()]
    }
  }

  private async resolveScope(
    scope: ExternalScopeRecord,
    principals: readonly SlackPrincipal[],
    signal: AbortSignal
  ): Promise<Verdict> {
    if (
      scope.provider !== 'slack' ||
      scope.resourceKind !== 'conversation' ||
      scope.revokedAt !== null ||
      scope.credentialKind !== 'bot' ||
      !scope.credentialId
    ) {
      return { decision: 'deny' }
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
      return unresolved('bot_unresolved')
    }
    let unknownReason: DegradedReason | undefined
    for (const principal of principals) {
      const key = [scope.id, scope.aclRevision.toString(), bot.credentialRevision, principal.key].join(':')
      let verdict = this.cache.get(key)
      if (!verdict) {
        const { evidenceAt, ...checked } = await this.checkAccess(
          scope,
          principal,
          bot.id,
          bot.credentialRevision,
          signal
        )
        verdict = checked
        this.putCache(key, verdict, evidenceAt)
      }
      if (verdict.decision === 'allow') return verdict
      // The FIRST cause is kept, not the last, so one degraded scope reports
      // one reason and the counts in `resolve` still sum to `unknownScopes`.
      if (verdict.decision === 'unknown') unknownReason ??= verdict.reason ?? 'unreported'
    }
    return unknownReason ? { decision: 'unknown', reason: unknownReason } : { decision: 'deny' }
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
    if (!secret?.botToken) return { ...unresolved('bot_token_missing'), evidenceAt: now }
    try {
      const observed = await this.audienceOf(
        [botId, credentialRevision, scope.resourceKey].join(':'),
        scope.resourceKey,
        secret.botToken,
        signal
      )
      // Only reachable if the entry is dropped mid-flight; fail closed.
      if (!observed) return { ...unresolved('audience_evicted'), evidenceAt: now }
      const evidenceAt = observed.fetchedAt
      // The conversation is gone (or the bot is no longer in it): a settled fact
      // about the audience, not an unavailable check.
      if (observed.audience === 'gone') return { decision: 'deny', evidenceAt }
      if (observed.audience === 'unknown') return { decision: 'unknown', reason: observed.reason, evidenceAt }
      if (observed.audience === 'public') {
        const { access, ...cause } = await this.workspaceAccess(
          scope.realmKey,
          principal,
          credentialRevision,
          secret.botToken,
          signal
        )
        if (access !== 'membership') return { decision: access, ...cause, evidenceAt }
        const member = await this.checkMembership(scope.resourceKey, principal.userId, secret.botToken, signal)
        return { ...member, evidenceAt }
      }

      const member = await this.checkMembership(scope.resourceKey, principal.userId, secret.botToken, signal)
      if (member.decision !== 'allow' || principal.teamId === scope.realmKey) return { ...member, evidenceAt }

      // Slack Connect can return a member from another workspace. Verify the
      // identity's home team instead of treating the installing team as proof.
      const { access, ...cause } = await this.workspaceAccess(
        scope.realmKey,
        principal,
        credentialRevision,
        secret.botToken,
        signal
      )
      return access === 'unknown' || access === 'deny'
        ? { decision: access, ...cause, evidenceAt }
        : { decision: 'allow', evidenceAt }
    } catch (error) {
      return { ...unresolved(thrownReason(error)), evidenceAt: now }
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

  private async conversationAudience(channel: string, token: string, signal: AbortSignal): Promise<ReadAudience> {
    const body = await this.slackCall<{
      ok?: boolean
      error?: unknown
      channel?: { is_private?: unknown; is_im?: unknown; is_mpim?: unknown }
    }>(`conversations.info?channel=${encodeURIComponent(channel)}`, token, signal)
    if (!body.ok) {
      const failure = failureVerdict(body.error)
      return failure.decision === 'deny' ? { audience: 'gone' } : { audience: 'unknown', reason: failure.reason }
    }
    if (!body.channel) return { audience: 'unknown', reason: 'audience_unclassified' }
    if (body.channel.is_private === false && body.channel.is_im !== true && body.channel.is_mpim !== true) {
      return { audience: 'public' }
    }
    if (body.channel.is_private === true || body.channel.is_im === true || body.channel.is_mpim === true) {
      return { audience: 'members' }
    }
    return { audience: 'unknown', reason: 'audience_unclassified' }
  }

  private async workspaceAccess(
    realmKey: string,
    principal: SlackPrincipal,
    credentialRevision: number,
    token: string,
    signal: AbortSignal
  ): Promise<CheckedWorkspaceAccess> {
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

    // The initial value covers `ok` with no `user`: Slack answered, in a shape
    // no verdict can be read out of.
    let checked: CheckedWorkspaceAccess = { access: 'unknown', reason: 'user_unclassified' }
    if (!body.ok) {
      const failure = failureVerdict(body.error)
      // A user Slack does not know in this workspace is a verdict, not an outage.
      checked = failure.decision === 'deny' ? { access: 'deny' } : { access: 'unknown', reason: failure.reason }
    } else if (body.user) {
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
        checked = { access: 'deny' }
      } else if (
        !teams.has(realmKey) ||
        body.user.is_restricted === true ||
        body.user.is_ultra_restricted === true ||
        body.user.is_stranger === true ||
        body.user.is_external === true
      ) {
        checked = { access: 'membership' }
      } else {
        checked = { access: 'allow' }
      }
    }
    this.putWorkspaceAccess(key, checked)
    return checked
  }

  private async checkMembership(channel: string, userId: string, token: string, signal: AbortSignal): Promise<Verdict> {
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
      if (!body.ok) return failureVerdict(body.error)
      if (!Array.isArray(body.members)) return unresolved('members_unclassified')
      if (body.members.includes(userId)) return { decision: 'allow' }
      cursor = typeof body.response_metadata?.next_cursor === 'string' ? body.response_metadata.next_cursor : ''
      if (!cursor) return { decision: 'deny' }
      if (page === MAX_MEMBER_PAGES - 1) return unresolved('member_pages_exhausted')
    }
    return unresolved('member_pages_exhausted')
  }

  private async slackCall<T>(path: string, token: string, signal: AbortSignal): Promise<T> {
    const fetchImpl = this.deps.fetchImpl ?? (fetch as FetchLike)
    const response = await fetchImpl(`https://slack.com/api/${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal
    })
    if (!response.ok) throw new SlackCallFailed(`http_${response.status}`)
    return (await response.json()) as T
  }

  private putCache(key: string, verdict: Verdict, evidenceAt: number): void {
    const { decision } = verdict
    const ttl = decision === 'allow' ? ALLOW_TTL_MS : decision === 'deny' ? DENY_TTL_MS : UNKNOWN_TTL_MS
    // An `allow` is leased from the EVIDENCE it rests on — `start` is the
    // observation, not the reuse — so serving a cached audience can never
    // stretch the window a fresh `conversations.info` would have granted.
    // `deny` and `unknown` run from now: reused evidence can only narrow
    // access, never widen it, so there is nothing to bound.
    const start = decision === 'allow' ? Math.min(evidenceAt, this.deps.clock.now()) : undefined
    this.cache.set(key, verdict, { ttl, ...(start !== undefined ? { start } : {}) })
  }

  private putWorkspaceAccess(key: string, checked: CheckedWorkspaceAccess): void {
    const { access } = checked
    const ttl = access === 'allow' ? ALLOW_TTL_MS : access === 'unknown' ? UNKNOWN_TTL_MS : DENY_TTL_MS
    this.workspaceAccessCache.set(key, checked, { ttl })
  }
}
