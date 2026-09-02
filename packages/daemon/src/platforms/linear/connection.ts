/**
 * The Linear **Layer-1 connection** (linear-integration.md §9.4): one per-integration
 * egress client over plain GraphQL `fetch`.
 *
 * Linear has no socket — ingress is relay-terminated webhooks (§4.2) — so `start()` only
 * warms the access token and `stop()` clears the refresh timer. Egress is daemon-direct
 * (§4.6, single writer per session): activities and session updates, paced by one
 * `PlatformSendQueue` per integration (§5.3).
 *
 * TOKEN CUSTODY (§4.4/§7.3). The CP owns the client secret and the rotating refresh token
 * and is the single durable writer; the daemon starts from the ≤24 h snapshot the spec
 * carries and re-requests over `linearcred/request` once it is within
 * {@link RENEW_MARGIN_MS} of expiry. Renewal failure DEGRADES rather than breaks: the
 * cached token keeps serving until it actually expires, and only then does a send fail.
 * Token material never reaches a log line.
 *
 * The read port answers what Linear affords: `getChannelInfo` names the team behind a
 * channel id — the team is the channel (§4.5) — `listChannels` answers the workspace's
 * team list, and `getUserProfile` the Linear user, whose id the relay prefixes `linear:`;
 * everything else answers empty. There is no bot channel enumeration, no leave
 * affordance, and attachment download is deferred.
 */
import { randomUUID } from 'node:crypto'
import { linearChannelName, linearTeamGlyph } from './message-strategy.js'
import type { LinearTeamRef } from './message-strategy.js'
import type { LinearAttachmentInput, LinearActivityInput } from './turn-output.js'
import type { IntegrationLinearConfig, LinearCredGrant } from '@agentconnect.md/protocol'
import type { Agent } from '../../agents/agent-schema.js'
import type { Logger } from '../../log.js'
import type {
  PlatformChannelInfo,
  PlatformChannelRef,
  PlatformConnection,
  PlatformMemberRef,
  PlatformUserProfile
} from '../contract.js'
import { platformIntegrationConfig } from '../integration-config.js'
import { PlatformSendQueue } from '../send-queue.js'

/** Linear's single GraphQL endpoint (§2). Overridable per connection for tests only. */
export const LINEAR_GRAPHQL_ENDPOINT = 'https://api.linear.app/graphql'

/** Renew once the cached token is within this of expiry (§4.4 names 2 h). */
export const RENEW_MARGIN_MS = 2 * 60 * 60 * 1000

/** Minimum spacing between outbound writes — 5 000 req/h per app per workspace (§5.3). */
export const LINEAR_SEND_INTERVAL_MS = 1_000

/** How far past a renewal failure we retry rather than hammering the broker. */
const RENEW_RETRY_MS = 60_000

/** Cap on the team list one report carries — the console's channel rows, not a full crawl. */
const MAX_LISTED_TEAMS = 100

/** A read port's own deadline when its caller sets none — a stall costs a name, never a caller. */
export const LINEAR_READ_DEADLINE_MS = 5_000

/**
 * A retry of `agentActivityCreate` is only safe because the input carries our own id: creation
 * is append-only (§15), so an indeterminate failure — transport loss, 5xx after the write
 * committed — would otherwise post the same thought twice under two server ids. Linear refuses
 * the second write on the id instead, which we read as "the first attempt landed".
 *
 * Only these say that clearly. Anything else surfaces: swallowing an ambiguous refusal would
 * silently drop a real activity, which is the worse failure of the two.
 */
const DUPLICATE_ID_REFUSAL = /already exists|already been taken|duplicate|unique constraint/i

/** §11 bounded send retry: attempts per enqueued write, and the spacing between them. */
const SEND_MAX_ATTEMPTS = 3
const SEND_RETRY_BASE_MS = 1_000
/** Caps a provider-supplied `Retry-After` so one write cannot eat the queue's task budget. */
const SEND_RETRY_CAP_MS = 5_000

/** One agent activity's content (§5 `LinearAction`, the content half). */
export type LinearActivityContent =
  | { type: 'thought'; body: string }
  | { type: 'action'; action: string; parameter: string; result?: string }
  | { type: 'response'; body: string }
  | { type: 'error'; body: string }
  | { type: 'elicitation'; body: string }

/** One entry of the session plan; both sides are full-array replace (§5.1). */
export interface LinearPlanEntry {
  content: string
  status: 'pending' | 'inProgress' | 'completed' | 'canceled'
}

/** One labelled link on the session. */
export interface LinearExternalUrl {
  label: string
  url: string
}

/** What §10.2 auto-start did to the issue: one write, or a stated reason for none. */
export type LinearIssueStartOutcome =
  | { outcome: 'moved'; from: string; state: string }
  | { outcome: 'unchanged'; state: string }
  | { outcome: 'skipped'; reason: string }

/** The `agentSessionUpdate` input this connection is allowed to send (§2). */
export interface LinearSessionUpdate {
  plan?: LinearPlanEntry[]
  externalUrls?: LinearExternalUrl[]
  addedExternalUrls?: LinearExternalUrl[]
  removedExternalUrls?: LinearExternalUrl[]
}

/** A Linear API refusal — GraphQL `errors[]` or a non-2xx response. */
export class LinearApiError extends Error {
  constructor(
    message: string,
    /** Worth another attempt (5xx, 429, transport, `RATELIMITED`). A rejected token or a bad input is not. */
    readonly retryable: boolean,
    /** Linear's `extensions.code` on the first error, when it reported one. */
    readonly code?: string,
    /** The provider's own `Retry-After`, when it sent one — preferred over our backoff. */
    readonly retryAfterMs?: number
  ) {
    super(message)
    this.name = 'LinearApiError'
  }
}

/** No usable token: the snapshot expired and renewal did not answer (§11 "token refresh fails"). */
export class LinearTokenUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LinearTokenUnavailableError'
  }
}

/** One connection's worth of consolidated integrations (§7.5 registry group shape). */
export interface ConsolidatedLinearGroup {
  key: string
  agentId: string
  integrationId: string
  config: IntegrationLinearConfig
  integrations: { agentId: string; integrationId: string }[]
}

/**
 * §7.5 opaque identity of one Linear egress client. Keyed by the INTEGRATION, because the
 * spec token is per-integration and §5.3 paces per integration — the workspace is carried
 * so a re-pointed integration reconnects instead of silently writing to another workspace.
 * The token itself is deliberately absent: it rotates, the identity does not.
 */
export function linearConnKey(c: { integrationId: string; workspaceId: string }): string {
  return `${c.integrationId}\u0000${c.workspaceId}`
}

/** Group an agent set's Linear integrations, one connection each. A config the module's
 *  schema rejects is skipped with a warning — fail closed, never half-served (§6.4). */
export function consolidateLinear(agents: Agent[], log?: Logger): Map<string, ConsolidatedLinearGroup> {
  const groups = new Map<string, ConsolidatedLinearGroup>()
  for (const a of agents) {
    for (const int of a.integrations) {
      if (int.platform !== 'linear') continue
      const config = platformIntegrationConfig('linear', int)
      if (!config) {
        log?.warn(`linear: integration ${int.id} skipped — config failed the linear schema`)
        continue
      }
      const key = linearConnKey({ integrationId: int.id, workspaceId: config.workspaceId })
      groups.set(key, {
        key,
        agentId: a.id,
        integrationId: int.id,
        config,
        integrations: [{ agentId: a.id, integrationId: int.id }]
      })
    }
  }
  return groups
}

export interface LinearDeps {
  group: ConsolidatedLinearGroup
  /** D→C `linearcred/request` — the CP resolves integration → bot → workspace token itself. */
  requestToken: (payload: { integrationId: string }) => Promise<LinearCredGrant>
  log?: Logger
  /** GraphQL endpoint; tests point it at a fake. */
  endpoint?: string
  /** Injected so tests need no network. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Min spacing (ms) between outbound writes. Tests pass 0. */
  sendIntervalMs?: number
  /** Wall clock, injectable for tests. Token expiry is absolute time, not a TTL. */
  now?: () => number
  /** Send-queue sleep, injectable so a fake clock does not wait in real time. */
  sleep?: (ms: number) => Promise<void>
  /** Refresh-ahead timer, injectable for tests. Defaults to unref'd `setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** Idempotency key per activity; injectable so tests are deterministic. Defaults to `randomUUID`. */
  newActivityId?: () => string
}

interface CachedToken {
  token: string
  /** Absolute wall-clock expiry (ms). `NaN` when the source string did not parse. */
  expiresAtMs: number
}

const defaultSetTimer = (fn: () => void, ms: number): unknown => {
  const t = setTimeout(fn, ms)
  ;(t as { unref?: () => void }).unref?.()
  return t
}

/** The relay's sender id is `linear:<userId>` (§6.1); Linear's API wants the bare id. */
export function bareLinearUserId(id: string): string {
  return id.startsWith('linear:') ? id.slice('linear:'.length) : id
}

/** Sessions remembered per connection — a bound, not a budget; a follow-up re-learns its issue. */
const SESSION_ISSUE_CACHE_MAX = 4096

export class LinearConnection implements PlatformConnection {
  /** All outbound writes funnel through one queue so activities land in converger order. */
  private readonly queue: PlatformSendQueue
  private readonly endpoint: string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  /** The issue each AgentSession was opened on, learned off every delivery (§12). */
  private readonly issueBySession = new Map<string, string>()
  private readonly clearTimer: (handle: unknown) => void
  private readonly newActivityId: () => string
  private cached: CachedToken
  /** Single-flight: concurrent sends inside the margin issue ONE `linearcred/request`. */
  private renewal: Promise<CachedToken> | undefined
  /** Wall-clock deadline before which a failed renewal is not retried. */
  private renewBlockedUntil = 0
  private refreshTimer: unknown
  private stopped = false

  readonly integrationId: string
  readonly agentId: string
  /** The Linear organization id — this connection's durable tenant, surviving token rotation. */
  private readonly organizationId: string
  readonly workspaceName?: string
  /** The app's own Linear user id: Linear's app user IS this connection's bot identity,
   *  so it answers the contract's `botUserId` and backs the ingress self-echo guard (§7.2). */
  readonly botUserId?: string
  /** Linear exposes no per-workspace permalink base here, so the daemon's deep-link base
   *  falls through to the configured Web App URL — same posture as Feishu. */
  readonly workspaceUrl = ''

  constructor(private readonly deps: LinearDeps) {
    const { config } = deps.group
    this.integrationId = deps.group.integrationId
    this.agentId = deps.group.agentId
    this.organizationId = config.workspaceId
    if (config.workspaceName !== undefined) this.workspaceName = config.workspaceName
    if (config.appUserId !== undefined) this.botUserId = config.appUserId
    this.endpoint = deps.endpoint ?? LINEAR_GRAPHQL_ENDPOINT
    this.fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
    this.now = deps.now ?? (() => Date.now())
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.setTimer = deps.setTimer ?? defaultSetTimer
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    this.newActivityId = deps.newActivityId ?? (() => randomUUID())
    this.cached = { token: config.accessToken, expiresAtMs: Date.parse(config.accessTokenExpiresAt) }
    this.queue = new PlatformSendQueue(deps.sendIntervalMs ?? LINEAR_SEND_INTERVAL_MS, this.now, deps.sleep)
  }

  workspaceId(): string {
    return this.organizationId
  }

  /** Is this Linear user the app itself? The ingress self-echo guard (§7.2 `appUserId`). */
  isSelfAuthored(userId: string | undefined): boolean {
    return userId !== undefined && this.botUserId !== undefined && userId === this.botUserId
  }

  /** Adopt a re-pushed spec's token without reconnecting — the identity key is unchanged
   *  by rotation, so a CP refresh converges here rather than through a teardown. */
  applySnapshot(config: IntegrationLinearConfig): void {
    const expiresAtMs = Date.parse(config.accessTokenExpiresAt)
    if (Number.isNaN(expiresAtMs) || expiresAtMs <= this.cached.expiresAtMs) return
    this.cached = { token: config.accessToken, expiresAtMs }
    this.renewBlockedUntil = 0
    this.scheduleRefresh()
  }

  // ── 1. transport lifecycle ──

  /** No socket to open: warm the token so the first activity does not pay a broker
   *  round-trip inside Linear's ≤10 s ack budget (§10.1). Best-effort by contract. */
  async start(): Promise<void> {
    this.stopped = false
    try {
      await this.token()
    } catch (err) {
      this.deps.log?.warn(
        `linear: token warm-up failed for integration ${this.integrationId}: ${(err as Error).message}`
      )
    }
    this.scheduleRefresh()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.refreshTimer !== undefined) {
      this.clearTimer(this.refreshTimer)
      this.refreshTimer = undefined
    }
  }

  // ── 2. egress (§4.6 single writer) ──

  /** `agentActivityCreate` — one row in the Linear agent-session feed. Returns the activity id,
   *  which is OURS: minted once here, before the first attempt, and reused by every retry so an
   *  indeterminate failure cannot append the same activity twice. */
  async createActivity(
    agentSessionId: string,
    content: LinearActivityContent,
    opts: { ephemeral?: boolean; signal?: string } = {}
  ): Promise<string | undefined> {
    const id = this.newActivityId()
    const input: Record<string, unknown> = { id, agentSessionId, content }
    if (opts.ephemeral !== undefined) input.ephemeral = opts.ephemeral
    if (opts.signal !== undefined) input.signal = opts.signal
    type CreatePayload = { agentActivityCreate?: { success?: boolean; agentActivity?: { id?: string } | null } }
    const data = await this.enqueueGraphql<CreatePayload>(AGENT_ACTIVITY_CREATE, { input }, () => ({
      agentActivityCreate: { agentActivity: { id } }
    }))
    return data.agentActivityCreate?.agentActivity?.id ?? id
  }

  /** {@link LinearEgressPort}'s half of {@link createActivity}: the Layer-2 surface emits a FLAT
   *  activity input, and the discriminated content union is this connection's own shape. */
  async postActivity(agentSessionId: string, activity: LinearActivityInput): Promise<void> {
    await this.createActivity(
      agentSessionId,
      activity.type === 'action'
        ? {
            type: 'action',
            action: activity.action ?? '',
            parameter: activity.parameter ?? '',
            ...(activity.result !== undefined ? { result: activity.result } : {})
          }
        : { type: activity.type, body: activity.body ?? '' },
      activity.ephemeral !== undefined ? { ephemeral: activity.ephemeral } : {}
    )
  }

  /** `agentSessionUpdate` — the session-level surfaces (§2). Needs no idempotency key: `plan` and
   *  `externalUrls` are full-array replaces, so a retry converges on the same state. */
  async updateSession(agentSessionId: string, update: LinearSessionUpdate): Promise<void> {
    await this.enqueueGraphql<{ agentSessionUpdate?: { success?: boolean } }>(AGENT_SESSION_UPDATE, {
      id: agentSessionId,
      input: update
    })
  }

  /** Remember which issue a session sits on; the newest entry is the last evicted. */
  noteSessionIssue(sessionId: string, issueId: string): void {
    this.issueBySession.delete(sessionId)
    this.issueBySession.set(sessionId, issueId)
    if (this.issueBySession.size > SESSION_ISSUE_CACHE_MAX)
      this.issueBySession.delete(this.issueBySession.keys().next().value!)
  }

  /** The issue a session was opened on, when a delivery on this connection has said so. */
  issueOfSession(sessionId: string): string | undefined {
    return this.issueBySession.get(sessionId)
  }

  /** `attachmentCreate` — the issue's Resources entry. Needs no idempotency key of ours: Linear
   *  treats the URL as one per issue, so a retry or a later turn refreshes the same entry. */
  async createIssueAttachment(input: LinearAttachmentInput): Promise<void> {
    await this.enqueueGraphql<{ attachmentCreate?: { success?: boolean } }>(ATTACHMENT_CREATE, { input })
  }

  /** Full-array plan replace — both sides have the same semantics (§5.1). */
  async updateSessionPlan(agentSessionId: string, entries: LinearPlanEntry[]): Promise<void> {
    await this.updateSession(agentSessionId, { plan: entries })
  }

  /** One authenticated GraphQL request for the agent-facing tools (`agent-tools.ts`), on the
   *  paced queue with the bounded retry: the agent shares the workspace's hourly budget with
   *  every feed write, so its reads and writes take a slot like anything else. A CREATE must
   *  pass `onDuplicateKey` alongside a client-minted id in its input — that is what makes the
   *  indeterminate retry safe, exactly as `createActivity` does for the feed. */
  async request<T>(
    query: string,
    variables: Record<string, unknown>,
    opts: { onDuplicateKey?: () => T } = {}
  ): Promise<T> {
    return await this.enqueueGraphql<T>(query, variables, opts.onDuplicateKey)
  }

  /** Additive link publication, so a later turn never drops an earlier turn's links. */
  async addSessionExternalUrls(agentSessionId: string, urls: LinearExternalUrl[]): Promise<void> {
    if (urls.length === 0) return
    await this.updateSession(agentSessionId, { addedExternalUrls: urls })
  }

  /**
   * §10.2 auto-start: move a freshly delegated issue into its team's first `started` state.
   *
   * Reads the issue's current state and the team's workflow, then writes at most once. An issue
   * already `started`/`completed`/`canceled` is left alone; one in `triage` is skipped so a
   * Linear-side automation that delegates out of triage keeps human triage; a team with no
   * `started` state has nothing to move to. Both requests ride the paced queue: the read is the
   * first half of one write, not a read-port answer that may degrade to a default.
   */
  async startIssue(issueId: string): Promise<LinearIssueStartOutcome> {
    type StatePayload = {
      issue?: {
        state?: { id?: string; name?: string; type?: string } | null
        team?: { states?: { nodes?: { id?: string; name?: string; type?: string; position?: number }[] } | null } | null
      } | null
    }
    const data = await this.enqueueGraphql<StatePayload>(ISSUE_STATE_QUERY, { id: issueId })
    const current = data.issue?.state
    if (!current?.type) return { outcome: 'skipped', reason: 'issue or its state is unreadable' }
    if (current.type === 'started' || current.type === 'completed' || current.type === 'canceled')
      return { outcome: 'unchanged', state: current.name ?? current.type }
    if (current.type === 'triage') return { outcome: 'skipped', reason: 'issue is in triage' }
    const target = (data.issue?.team?.states?.nodes ?? [])
      .filter((s) => s.type === 'started' && s.id)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0]
    if (!target?.id) return { outcome: 'skipped', reason: 'team has no started state' }
    await this.enqueueGraphql<{ issueUpdate?: { success?: boolean } }>(ISSUE_UPDATE, {
      id: issueId,
      input: { stateId: target.id }
    })
    return { outcome: 'moved', from: current.name ?? current.type, state: target.name ?? target.id }
  }

  // ── 3. read / query port ──

  /**
   * The channel is the issue's TEAM (§4.5), so this names the team behind a channel id —
   * `<Workspace name> / <Team name>`, never an issue: the one display slot is shared by every
   * session in the team, and never the team KEY, which is an identifier rather than a label.
   *
   * On the DIRECT read path like `getUserProfile`, and DEADLINE-BOUND end to end: the caller's
   * signal when it has one, else {@link LINEAR_READ_DEADLINE_MS} of its own, because a provider
   * that accepts and then stalls must cost a display name and never a caller. Degrades to the
   * bare id on any refusal — a row the console cannot label still routes. The workspace id — the
   * issue-less channel, which has no team — is answered from the spec without a lookup at all.
   */
  async getChannelInfo(channel: string, opts: { signal?: AbortSignal } = {}): Promise<PlatformChannelInfo> {
    if (channel === this.organizationId) {
      const name = linearChannelName(undefined, this)
      return { id: channel, ...(name !== channel ? { name } : {}), isIm: false }
    }
    try {
      const signal = opts.signal ?? AbortSignal.timeout(LINEAR_READ_DEADLINE_MS)
      const data = await this.graphql<{ team?: LinearTeamRef | null }>(TEAM_QUERY, { id: channel }, signal)
      const name = data.team ? linearChannelName({ ...data.team, id: channel }, this) : ''
      return { id: channel, ...(name && name !== channel ? { name } : {}), ...linearTeamGlyph(data.team), isIm: false }
    } catch (err) {
      this.deps.log?.debug(`linear: team lookup failed (${channel}): ${(err as Error).message}`)
      return { id: channel, isIm: false }
    }
  }

  /** Answers under the caller's own key: the relay hands out `linear:<userId>`, Linear wants the
   *  bare id, and the display cache is keyed by whatever the message carried. */
  async getUserProfile(user: string): Promise<PlatformUserProfile> {
    const id = bareLinearUserId(user)
    try {
      const data = await this.graphql<{
        user?: { id?: string; name?: string; displayName?: string; avatarUrl?: string | null } | null
      }>(USER_QUERY, { id })
      const u = data.user
      if (!u) return { id: user, isBot: this.isSelfAuthored(id) }
      return {
        id: user,
        ...(u.displayName ? { name: u.displayName } : {}),
        ...(u.name ? { realName: u.name } : {}),
        ...(u.avatarUrl ? { avatarUrl: u.avatarUrl } : {}),
        // A plain user read carries no bot flag; the app's own id is the one we can name (§7.2).
        isBot: this.isSelfAuthored(u.id ?? id)
      }
    } catch (err) {
      this.deps.log?.debug(`linear: user lookup failed (${id}): ${(err as Error).message}`)
      return { id: user, isBot: this.isSelfAuthored(id) }
    }
  }

  /** Linear issues have no member roster core can enumerate. */
  async listMembers(_channel: string): Promise<PlatformMemberRef[]> {
    return []
  }

  /**
   * The workspace's teams — the channels of this install (§4.5). Bounded three ways: at
   * {@link MAX_LISTED_TEAMS} rows, by the caller's `signal` (else
   * {@link LINEAR_READ_DEADLINE_MS}) end to end including the token wait, and by answering
   * empty rather than throwing — the report it feeds is a non-authoritative name refresh over
   * rows the CP already wrote (§9.2), so it may never outlive its deadline or fail a caller.
   */
  async listChannels(opts: { signal?: AbortSignal } = {}): Promise<PlatformChannelRef[]> {
    try {
      const signal = opts.signal ?? AbortSignal.timeout(LINEAR_READ_DEADLINE_MS)
      const data = await this.graphql<{ teams?: { nodes?: LinearTeamRef[] } | null }>(TEAMS_QUERY, {}, signal)
      return (data.teams?.nodes ?? [])
        .filter((node) => Boolean(node?.id))
        .map((node) => {
          const name = linearChannelName(node, this)
          return {
            id: node.id,
            ...(name && name !== node.id ? { name } : {}),
            ...linearTeamGlyph(node),
            isPrivate: false
          }
        })
    } catch (err) {
      this.deps.log?.debug(`linear: team list failed for integration ${this.integrationId}: ${(err as Error).message}`)
      return []
    }
  }

  /** Attachment download is deferred (§9.4) — `null` is "unavailable", never a throw. */
  async downloadFile(_ref: string, _maxBytes?: number): Promise<Buffer | null> {
    return null
  }

  // ── token cache (§4.4) ──

  /** The live access token: the cached one while it is outside the safety margin, else a
   *  single-flight `linearcred` renewal. A failed renewal keeps serving the cached token
   *  until it actually expires; past expiry the caller gets a hard error. */
  async token(): Promise<string> {
    const now = this.now()
    if (!this.needsRenewal(now)) return this.cached.token
    // The backoff holds whether or not the cached token outlived it: an expired token is
    // exactly when a per-send retry would hammer the broker through an outage.
    if (now < this.renewBlockedUntil) {
      if (this.stillValid(now)) return this.cached.token
      throw new LinearTokenUnavailableError(
        `linear access token for integration ${this.integrationId} expired and renewal is backing off`
      )
    }
    try {
      return (await this.renew()).token
    } catch (err) {
      if (this.stillValid(this.now())) {
        this.deps.log?.warn(
          `linear: token renewal failed for integration ${this.integrationId} — serving the cached token (${(err as Error).message})`
        )
        return this.cached.token
      }
      throw new LinearTokenUnavailableError(
        `linear access token for integration ${this.integrationId} expired and renewal failed: ${(err as Error).message}`
      )
    }
  }

  private needsRenewal(now: number): boolean {
    return Number.isNaN(this.cached.expiresAtMs) || this.cached.expiresAtMs - now <= RENEW_MARGIN_MS
  }

  private stillValid(now: number): boolean {
    return !Number.isNaN(this.cached.expiresAtMs) && this.cached.expiresAtMs > now
  }

  private renew(): Promise<CachedToken> {
    if (this.renewal) return this.renewal
    const pending = this.deps
      .requestToken({ integrationId: this.integrationId })
      .then((grant) => {
        const expiresAtMs = Date.parse(grant.expiresAt)
        // A grant we cannot date is still fresh: give it one margin rather than forever.
        const next: CachedToken = {
          token: grant.accessToken,
          expiresAtMs: Number.isNaN(expiresAtMs) ? this.now() + RENEW_MARGIN_MS : expiresAtMs
        }
        this.cached = next
        this.renewBlockedUntil = 0
        this.scheduleRefresh()
        return next
      })
      .catch((err: unknown) => {
        this.renewBlockedUntil = this.now() + RENEW_RETRY_MS
        // Re-arm on the failure path too: without this a transient refusal leaves an idle
        // integration with no timer at all, so recovery is only ever found by a live send.
        this.scheduleRefresh()
        throw err
      })
      .finally(() => {
        this.renewal = undefined
      })
    this.renewal = pending
    return pending
  }

  /** Refresh AHEAD of the margin so an idle integration's next activity is not the thing
   *  that discovers an expired token. One timer, replaced on every token swap. */
  private scheduleRefresh(): void {
    if (this.refreshTimer !== undefined) {
      this.clearTimer(this.refreshTimer)
      this.refreshTimer = undefined
    }
    if (this.stopped || Number.isNaN(this.cached.expiresAtMs)) return
    // Due at the margin, or at the end of a renewal backoff — whichever is later.
    const dueAt = Math.max(this.cached.expiresAtMs - RENEW_MARGIN_MS, this.renewBlockedUntil)
    const delay = Math.max(RENEW_RETRY_MS, dueAt - this.now())
    this.refreshTimer = this.setTimer(() => {
      this.refreshTimer = undefined
      // Re-arm whatever the outcome, so no single failure ends the refresh chain.
      void this.token()
        .catch(() => undefined)
        .finally(() => this.scheduleRefresh())
    }, delay)
  }

  // ── GraphQL transport ──

  /** The paced egress path, with the §11 bounded retry: activities are droppable chrome, so a
   *  retryable refusal gets a few spaced attempts inside the caller's one queue slot (order is
   *  preserved) and a terminal one fails at once. Read-port calls do not retry — they already
   *  degrade to a default. */
  private async enqueueGraphql<T>(
    query: string,
    variables: Record<string, unknown>,
    /** Present when the write carries an idempotency key: the value to resolve with if a RETRY is
     *  refused because that key already exists, which means the earlier attempt committed. */
    onDuplicateKey?: () => T
  ): Promise<T> {
    return this.queue.enqueue(async () => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await this.graphql<T>(query, variables)
        } catch (err) {
          // Only ever on a RETRY: a first-attempt duplicate means the caller reused a key across
          // two logical writes, which is a bug to surface rather than a success to invent.
          if (attempt > 1 && onDuplicateKey && isDuplicateKeyRefusal(err)) {
            this.deps.log?.debug('linear: retry refused on an existing id — the earlier attempt committed')
            return onDuplicateKey()
          }
          const retryable = err instanceof LinearApiError && err.retryable
          if (!retryable || attempt >= SEND_MAX_ATTEMPTS) throw err
          const backoff = (err as LinearApiError).retryAfterMs ?? SEND_RETRY_BASE_MS * 2 ** (attempt - 1)
          await this.sleep(Math.min(backoff, SEND_RETRY_CAP_MS))
        }
      }
    })
  }

  /**
   * The access token, but never past a signalled caller's deadline.
   *
   * `token()` can wait on `requestLinearCred()`, whose correlator timeout is far longer than a
   * read's deadline, so awaiting it plainly would leave a signalled read unbounded. Only THIS
   * caller gives up: the single-flight renewal keeps running, so the next caller — an ack, say —
   * still gets the renewed token rather than paying for a fresh round trip.
   */
  private async tokenWithin(signal?: AbortSignal): Promise<string> {
    const pending = this.token()
    if (!signal) return await pending
    // This caller is walking away from `pending`; nobody else may see it as unhandled.
    void pending.catch(() => undefined)
    let onAbort: (() => void) | undefined
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          if (signal.aborted) return reject(abortedRead())
          onAbort = () => reject(abortedRead())
          signal.addEventListener('abort', onAbort, { once: true })
        })
      ])
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const token = await this.tokenWithin(signal)
    // A token that arrived after the deadline must not become a live fetch.
    if (signal?.aborted) throw abortedRead()
    let res: Response
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ query, variables }),
        ...(signal ? { signal } : {})
      })
    } catch (err) {
      throw new LinearApiError(`linear request failed: ${(err as Error).message}`, true)
    }
    // Parse BEFORE branching on the status: Linear reports a rate limit as HTTP 400 carrying
    // `RATELIMITED` in the GraphQL errors, so a status-only verdict would call it terminal.
    let body: { data?: T; errors?: { message?: string; extensions?: { code?: string } }[] } | undefined
    try {
      body = (await res.json()) as typeof body
    } catch {
      body = undefined
    }
    if (body?.errors && body.errors.length > 0) {
      const code = body.errors[0]?.extensions?.code
      const message = body.errors.map((e) => e.message ?? 'unknown error').join('; ')
      const retryable = code === 'RATELIMITED' || retryableStatus(res.status)
      throw new LinearApiError(`linear rejected the request: ${message}`, retryable, code, retryAfterMs(res))
    }
    if (!res.ok) {
      throw new LinearApiError(
        `linear responded ${res.status}`,
        retryableStatus(res.status),
        undefined,
        retryAfterMs(res)
      )
    }
    if (body === undefined) throw new LinearApiError('linear returned an unreadable body', true)
    if (body.data === undefined) throw new LinearApiError('linear returned no data', true)
    return body.data
  }
}

/** The one refusal a blown read deadline raises — retryable, and nothing was ever sent. */
function abortedRead(): LinearApiError {
  return new LinearApiError('linear read aborted before it was sent', true)
}

/** Does this refusal clearly say our idempotency key is already committed? Conservative by
 *  construction — an ambiguous error is surfaced, never read as a silent success. */
function isDuplicateKeyRefusal(err: unknown): boolean {
  return err instanceof LinearApiError && DUPLICATE_ID_REFUSAL.test(err.message)
}

/** Status-only verdict, the fallback when the body names no code of its own. */
function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

/** `Retry-After`, as delta-seconds or an HTTP date. Absent/unparseable ⇒ the caller's own backoff. */
function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers?.get?.('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(raw)
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
}

// The documents this connection sends. Shapes follow Linear's published agent API
// (linear-integration.md §2); anything beyond them is a Layer-2 or later concern.
const AGENT_ACTIVITY_CREATE = `mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
  agentActivityCreate(input: $input) { success agentActivity { id } }
}`

const AGENT_SESSION_UPDATE = `mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
  agentSessionUpdate(id: $id, input: $input) { success }
}`

const ATTACHMENT_CREATE = `mutation AttachmentCreate($input: AttachmentCreateInput!) {
  attachmentCreate(input: $input) { success }
}`

const ISSUE_STATE_QUERY = `query IssueState($id: String!) {
  issue(id: $id) {
    state { id name type }
    team { states(first: 50) { nodes { id name type position } } }
  }
}`

const ISSUE_UPDATE = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`

const USER_QUERY = `query User($id: String!) {
  user(id: $id) { id name displayName avatarUrl }
}`

const TEAM_QUERY = `query Team($id: String!) {
  team(id: $id) { id key name icon color }
}`

const TEAMS_QUERY = `query Teams {
  teams(first: ${MAX_LISTED_TEAMS}) { nodes { id key name icon color } }
}`
