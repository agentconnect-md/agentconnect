/**
 * `RelayIngressManager` (shared-bot-relay.md §10 / §12) — glues the CP's HTTP-bot
 * control frames (`rc/bot-assign` / `rc/bot-unassign` / `rc/routes` / `rc/assign`)
 * to the ingest lifecycle, arbitration ({@link BotArbitrationRouter}), and forwarding
 * onto the target daemon (`rd/msg` `im`).
 *
 * Flow: `rc/bot-assign` loads the bot's inbound routing + credentials; inbound
 * arrives via the public Slack or Feishu callback routes, which authenticate,
 * normalize, arbitrate, and forward to the resolved daemon as a pre-addressed
 * `rd/msg(im)`. A daemon that is offline / has no connection here is a TYPED
 * delivery miss → bounded-loss drop + count (never a silent success, §17).
 *
 * Affinity (§10 step 3, the 3-leg dance): on the FIRST route of a (channel, thread)
 * `sessionKey` (or a Switch-agent) the manager REPORTS it to the CP (`rc/thread-assign`);
 * on an un-mentioned follow-up it has no cached affinity for, it PULLS the persisted
 * owner from the CP (`rc/thread-lookup`) rather than dropping the message.
 */
import { createHash } from 'node:crypto'
import { MAX_AGENT_CALL_HOPS, WireFeishuCardActionResponse, WireFeishuCardActionValue } from '@agentconnect.md/protocol'
import type {
  RdMsgIm,
  RdMsgPlatformAction,
  RcBotChannels,
  RcBotConversation,
  RcBotRevoked,
  WireFeishuCardActionEvent,
  WireNormalizedMessage,
  RcThreadAssign,
  RcThreadLookup
} from '@agentconnect.md/protocol'
import type { Clock } from '@agentconnect.md/connection'
import type { Logger } from './log.js'
import { BotArbitrationRouter, sessionKeyOf, type BotAssignment, type RouteTarget } from './bot-arbitration.js'
import { SlackHttpIngest, type HttpSlackSessionAction, type HttpSlackSessionShortcut } from './slack-http-ingest.js'
import { FeishuHttpIngest } from './feishu-http-ingest.js'
import type { FeishuVerifiedDelivery } from './feishu-http-ingress.js'
import { verifySlackSignature } from './hooks/signature.js'
import type { RelayDaemonConnection } from './relay-daemon-connection.js'

/** Cap on the learned `api_app_id → botId` demux index before it is flushed. */
const MAX_DEMUX_ENTRIES = 10_000

/** Composite demux key for one workspace install of a distributed app. */
function appTeamKey(apiAppId: string, teamId: string): string {
  return `${apiAppId}\u0000${teamId}`
}

/** Cap on the retry buffer for thread-assign reports dropped while the CP link was
 *  down. Bounded so a long CP outage can't grow it without limit; oldest-cleared. */
const MAX_PENDING_REPORTS = 10_000

/** Backoff for re-reporting an unacknowledged revocation while the CP link stays
 *  READY. The CP answers a transient persistence failure with a retryable error
 *  WITHOUT dropping the socket, so `onReady` (reconnect-only) can never be the
 *  sole retry trigger. Bounded: 5s → 10s → … → 60s. */
const REVOKE_RETRY_INITIAL_MS = 5_000
const REVOKE_RETRY_MAX_MS = 60_000

/** Provably-older ordering between two revoke reports for one bot: by credential
 *  generation first, then by Slack's occurrence time when the generations agree
 *  (or are absent — a legacy bot carries neither). "Not provably older" preserves
 *  arrival order, which is all an unfenced report has. */
function isOlderRevokeReport(incoming: RcBotRevoked, queued: RcBotRevoked): boolean {
  if (
    incoming.credentialRevision !== undefined &&
    queued.credentialRevision !== undefined &&
    incoming.credentialRevision !== queued.credentialRevision
  ) {
    return incoming.credentialRevision < queued.credentialRevision
  }
  // Same generation (or none to compare). A report WITHOUT an occurrence time is
  // the STRONGER claim, not a degenerate one: the auth.test dead-credential
  // backstop deliberately reports the exact current revision with no eventAtMs —
  // "this credential is dead NOW" — which passes the CP's time arm
  // unconditionally, while a timestamped lifecycle event of the same generation
  // may still be refused as predating the credential. Never let the weaker,
  // refusable report displace it; equal strength keeps arrival order.
  if (queued.eventAtMs === undefined) return incoming.eventAtMs !== undefined
  if (incoming.eventAtMs === undefined) return false
  return incoming.eventAtMs < queued.eventAtMs
}

export interface RelayIngressManagerDeps {
  /** A live `rd/*` connection to a daemon on THIS relay, or undefined if none. */
  getDaemon: (daemonId: string) => RelayDaemonConnection | undefined
  /** Persist a channel's default agent chosen in the config modal (→ CP `rc/set-channel-agent`). */
  setChannelAgent: (botId: string, channelId: string, agentId: string) => void
  /** Report the authoritative HTTP Slack channel-membership snapshot to the CP.
   *  Returns false when the CP link is down so the latest snapshot can be retried. */
  reportBotChannels: (m: RcBotChannels) => boolean
  /** Report one gated-DM conversation to the CP (§14.3, → `rc/bot-conversation`).
   *  Best-effort: loss self-heals on the counterpart's next DM. */
  reportBotConversation: (m: RcBotConversation) => boolean
  /** Report one DELIVERED §14.3 DM gating notice (→ `rc/notice-posted`) so the CP
   *  re-stamps the pool-wide latch. Best-effort: loss costs at most one duplicate
   *  notice later, never a lost enablement path. */
  reportNoticePosted: (m: { botId: string; channel: string }) => boolean
  /** Report a workspace uninstall / token revocation (→ `rc/bot-revoked`) so the CP
   *  marks the Bot + its installs revoked. Returns `false` when the CP link wasn't
   *  READY, so the manager can retry on reconnect ({@link
   *  RelayIngressManager.flushPendingReports}) — this report is NOT droppable: Slack
   *  acked the HTTP event before this ran and never redelivers it, and a dead token
   *  gives the CP nothing to observe. */
  reportBotRevoked: (m: RcBotRevoked) => Promise<boolean>
  /** Report the thread's now-resolved owner to the CP (→ `rc/thread-assign`). Returns
   *  `false` if the CP link was not READY and the frame was dropped, so the manager can
   *  retry it when the link recovers ({@link RelayIngressManager.flushPendingReports}). */
  reportThreadAssign: (m: RcThreadAssign) => boolean
  /** Pull a thread's persisted owner from the CP on an affinity miss (→ `rc/thread-lookup`). */
  lookupThread: (m: RcThreadLookup) => Promise<import('@agentconnect.md/protocol').RcThreadLookupOk>
  /** This pod's CP-assigned relayId (stable pool identity; undefined before the
   *  first register) — compared against the assignment's §14.3 noticeAuthority. */
  selfRelayId: () => string | undefined
  /** True when `targetAgentId`'s bot in this channel IS the app that sent the message.
   *  Two uses: recognizing AgentConnect-authored traffic at all, and — with the author's
   *  own id — proving that a claimed author is one of the agents that app represents
   *  (send-message-routing-rework.md §4 condition 3). */
  isAgentBotApp: (targetAgentId: string, platform: string, channelId: string, appId: string) => boolean
  /** The directional agent-call policy (caller outbound ∧ target inbound, one org), from
   *  the relay's own collaboration snapshot. Every author→target edge of a verified
   *  agent-authored message is checked independently through this (§5 closing paragraph);
   *  the carried recipient set is a claim until each edge passes CURRENT policy. */
  admitsAgentCall: (callerAgentId: string, targetAgentId: string) => boolean
  /** Clock for the inbound Slack HMAC replay window (`resolveVerified`). */
  clock: Clock
  log: Logger
}

/** Stable daemon-side dedup id for one Slack interaction. The hash deliberately omits
 *  open-config's one-shot triggerId (interactionId already identifies that click), so
 *  sensitive trigger material never leaks into logs or dedup keys. */
export function httpSlackActionMsgId(botId: string, action: HttpSlackSessionAction): string {
  const { target, interactionId, kind } = action
  let value: string | boolean | undefined
  switch (action.kind) {
    case 'set-model':
      value = action.model
      break
    case 'set-effort':
      value = action.effort
      break
    case 'set-permission-mode':
      value = action.permissionMode
      break
    case 'set-fast':
      value = action.fastMode
      break
    case 'set-output':
      value = action.outputMode
      break
    case 'permission-choice':
      value = `${action.requestId}:${action.optionId}`
      break
    case 'elicitation-choice':
      value = `${action.requestId}:${action.value ?? ''}`
      break
    case 'open-config':
    case 'cancel':
      break
  }
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        v: 1,
        botId,
        target: [target.v, target.agentId, target.integrationId, target.sessionKey],
        interactionId,
        kind,
        value
      })
    )
    .digest('hex')
  return `slack-action:${digest}`
}

export function httpSlackShortcutMsgId(botId: string, shortcut: HttpSlackSessionShortcut): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        v: 1,
        botId,
        channelId: shortcut.channelId,
        threadTs: shortcut.threadTs,
        interactionId: shortcut.interactionId
      })
    )
    .digest('hex')
  return `slack-action:${digest}`
}

export function httpFeishuActionMsgId(
  botId: string,
  eventId: string | undefined,
  action: WireFeishuCardActionEvent
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ v: 1, botId, eventId, action }))
    .digest('hex')
  return `feishu-action:${digest}`
}

export class RelayIngressManager {
  private readonly router = new BotArbitrationRouter()
  private readonly ingests = new Map<string, SlackHttpIngest>()
  private readonly feishuIngests = new Map<string, FeishuHttpIngest>()
  private readonly feishuBotByAppId = new Map<string, string>()
  private readonly feishuAppIdByBot = new Map<string, string>()
  /** Learned/assigned `api_app_id → botId` index — O(1) HTTP demux (self-populates on
   *  first verified delivery when the CP didn't stamp `apiAppId`). Bounded flush.
   *  Team-scoped bots (a distributed app's installs) NEVER enter this map — they
   *  demux exclusively on the composite index below. */
  private readonly demuxByApiApp = new Map<string, string>()
  /** Assigned `(api_app_id, team_id) → botId` composite index — the ONLY demux for
   *  a distributed app's installs, which all share one app id + signing secret.
   *  Assign-derived (never learned) and cleaned up on unassign via the reverse map. */
  private readonly demuxByAppTeam = new Map<string, string>()
  private readonly appTeamKeyByBot = new Map<string, string>()
  /** Bounded-loss counters (per bot) — messages dropped because no daemon connection. */
  private readonly dropped = new Map<string, number>()
  /** Thread-assign reports dropped because the CP link wasn't READY, keyed
   *  `botId\0sessionKey` (latest target wins). Re-emitted on reconnect via
   *  {@link flushPendingReports}; without this a report lost during a CP blip would
   *  never persist and un-mentioned follow-ups on other pods would drop permanently. */
  private readonly pendingReports = new Map<string, RcThreadAssign>()
  /** Latest bot-level channel snapshot dropped while the CP link was down. A full
   *  snapshot supersedes any older one for the same bot. */
  private readonly pendingChannelReports = new Map<string, RcBotChannels>()
  /** Revocation reports the CP link wasn't up for, keyed by botId (one bot revokes
   *  once; a later report for the same bot supersedes). Unlike the other queues
   *  this one is not merely an optimization: Slack already acked the HTTP event
   *  and will never redeliver it, and no CP-side probe can discover a dead token,
   *  so a dropped report leaves the console showing an uninstalled app as active
   *  forever. Flushed on READY by {@link flushPendingReports}. */
  private readonly pendingRevokedReports = new Map<string, RcBotRevoked>()
  /** §14 one-time gating-notice latch (`botId:channel`) on the AUTHORITY pod —
   *  correct because only one pod ever posts (deterministic per-bot authority). */
  private readonly gatedNoticesSent = new Set<string>()
  /** §14.3 per-conversation DM-report latch (`botId:channel`) — scoped to the
   *  CURRENT bot assignment: cleared on assign/unassign and whenever the gated
   *  member set changes, since rows belong to the installs of that moment. */
  private readonly gatedDmReported = new Set<string>()

  private clearGatedDmLatches(botId: string): void {
    const prefix = `${botId}:`
    for (const k of [...this.gatedDmReported]) if (k.startsWith(prefix)) this.gatedDmReported.delete(k)
  }

  constructor(private readonly deps: RelayIngressManagerDeps) {}

  /** Emit a thread-assign report; on a non-READY CP link stash it for retry. */
  private report(m: RcThreadAssign): void {
    const key = `${m.botId}\u0000${m.sessionKey}`
    if (this.deps.reportThreadAssign(m)) {
      this.pendingReports.delete(key)
    } else {
      if (this.pendingReports.size >= MAX_PENDING_REPORTS) this.pendingReports.clear()
      this.pendingReports.set(key, m)
    }
  }

  private reportChannels(m: RcBotChannels): void {
    if (this.deps.reportBotChannels(m)) this.pendingChannelReports.delete(m.botId)
    else this.pendingChannelReports.set(m.botId, m)
  }

  /** Backoff timer re-driving unacknowledged revocation reports on a READY link
   *  (see REVOKE_RETRY_INITIAL_MS); armed whenever the queue is non-empty. */
  private revokeRetryTimer: ReturnType<typeof setTimeout> | undefined
  private revokeRetryDelayMs = REVOKE_RETRY_INITIAL_MS

  /** Report a revocation and keep it queued until the CP ACKNOWLEDGES the commit.
   *  Queued FIRST, cleared only on the ack: a send the socket accepted is not
   *  evidence the CP persisted anything, and this report has no other source. */
  private reportRevoked(m: RcBotRevoked): void {
    // Arrival order must not choose the sole durable report: Slack lifecycle
    // events are unordered, so a DELAYED pre-reinstall event can land while the
    // current generation's report sits queued on a transient failure. Letting it
    // replace the entry would hand the queue to a report whose terminal
    // `applied:false` then clears it — losing the live revocation entirely. An
    // older report is also worthless on its own: the newer queued one subsumes
    // it, and the CP's fence would refuse it anyway.
    const queued = this.pendingRevokedReports.get(m.botId)
    if (queued && isOlderRevokeReport(m, queued)) {
      this.deps.log.warn(
        `relay-ingress(${m.botId}): dropping out-of-order revoke report (an at-least-as-new one is queued)`
      )
      return
    }
    this.pendingRevokedReports.set(m.botId, m)
    void this.deps
      .reportBotRevoked(m)
      .then((committed) => {
        // Clear ONLY when the queued entry is still exactly the report this ack
        // answers. A reinstall + second revoke can replace the entry while this
        // one is in flight — deleting by botId alone would erase that NEWER
        // report, and with it the only signal its dead credential ever produces.
        if (committed && this.pendingRevokedReports.get(m.botId) === m) {
          this.pendingRevokedReports.delete(m.botId)
          if (this.pendingRevokedReports.size === 0) this.revokeRetryDelayMs = REVOKE_RETRY_INITIAL_MS
        }
      })
      .catch(() => {
        /* stays queued — the finally below arms the retry */
      })
      .finally(() => this.armRevokeRetry())
  }

  /** Arm the READY-link retry for whatever is still queued. Single timer, bounded
   *  exponential backoff, disarmed by a drained queue; `onReady`'s flush resets
   *  the delay (a fresh link deserves a fast first attempt). */
  private armRevokeRetry(): void {
    if (this.revokeRetryTimer || this.pendingRevokedReports.size === 0) return
    const delay = this.revokeRetryDelayMs
    this.revokeRetryDelayMs = Math.min(this.revokeRetryDelayMs * 2, REVOKE_RETRY_MAX_MS)
    this.revokeRetryTimer = setTimeout(() => {
      this.revokeRetryTimer = undefined
      for (const [, m] of [...this.pendingRevokedReports]) this.reportRevoked(m)
    }, delay)
    // Never hold the process open for a retry timer.
    this.revokeRetryTimer.unref?.()
  }

  /** Re-emit reports, channel snapshots, and revocations dropped while the CP link
   *  was down (wired to the client's onReady). Each queue stops at the first frame
   *  that still can't be sent, keeping the rest. */
  flushPendingReports(): void {
    for (const [key, m] of [...this.pendingReports]) {
      if (!this.deps.reportThreadAssign(m)) break
      this.pendingReports.delete(key)
    }
    for (const [botId, snapshot] of [...this.pendingChannelReports]) {
      if (!this.deps.reportBotChannels(snapshot)) break
      this.pendingChannelReports.delete(botId)
    }
    // Replayed AS OBSERVED — `credentialRevision`/`eventAtMs` still describe the
    // generation that was live when Slack sent the event, which is exactly what
    // the CP's fence needs after an outage that spanned a re-install. Async: each
    // entry clears only when the CP acknowledges the commit, and a fresh link
    // resets the READY-retry backoff.
    this.revokeRetryDelayMs = REVOKE_RETRY_INITIAL_MS
    for (const [, m] of [...this.pendingRevokedReports]) this.reportRevoked(m)
  }

  /** `rc/bot-assign` — (re)load the routing table + (re)build the bot's HTTP ingest. */
  async assign(a: BotAssignment): Promise<void> {
    // A full (re)assignment can mean new installs / a changed gated set — stale
    // DM-report latches would starve a later gated install of its pending row.
    this.clearGatedDmLatches(a.botId)
    this.router.upsert(a)
    // Rebuild the ingest (secrets or transport may have rotated). Idempotent.
    await this.stopIngest(a.botId)
    this.forgetAppTeam(a.botId)
    this.forgetFeishuApp(a.botId)

    if (a.platform === 'feishu') {
      if (!a.apiAppId || !('verificationToken' in a.secrets)) {
        this.deps.log.warn(`relay-ingress(${a.botId}): incomplete Feishu HTTP assignment`)
        return
      }
      const ingest = new FeishuHttpIngest(a.botId, a.apiAppId, a.secrets, {
        onMessage: (message) => this.forward(a.botId, message),
        onCardAction: (action, eventId) => this.forwardFeishuAction(a.botId, action, eventId),
        now: () => this.deps.clock.now()
      })
      this.feishuIngests.set(a.botId, ingest)
      this.feishuBotByAppId.set(a.apiAppId, a.botId)
      this.feishuAppIdByBot.set(a.botId, a.apiAppId)
      return
    }
    if (a.platform !== 'slack') {
      this.deps.log.warn(`relay-ingress(${a.botId}): platform '${a.platform}' ingest not yet supported (milestone C)`)
      return
    }
    if (!('botToken' in a.secrets)) {
      this.deps.log.warn(`relay-ingress(${a.botId}): incomplete Slack HTTP assignment`)
      return
    }
    // Deterministic demux when the CP stamped the app id. A team-scoped bot (a
    // distributed app's install) goes ONLY into the composite index — an app-only
    // entry would serve every sibling workspace's events to this one bot.
    if (a.apiAppId && a.teamId) {
      this.demuxByAppTeam.set(appTeamKey(a.apiAppId, a.teamId), a.botId)
      this.appTeamKeyByBot.set(a.botId, appTeamKey(a.apiAppId, a.teamId))
      // A re-assign that GAINED a teamId must also evict any stale app-only entry
      // still pointing at this bot, or the fast path would keep serving cross-team.
      if (this.demuxByApiApp.get(a.apiAppId) === a.botId) this.demuxByApiApp.delete(a.apiAppId)
    } else if (a.apiAppId) {
      this.rememberApiApp(a.apiAppId, a.botId)
    }
    const ingest = new SlackHttpIngest(
      a.botId,
      { botToken: a.secrets.botToken, signingSecret: a.secrets.signingSecret },
      {
        onMessage: (msg) => this.forward(a.botId, msg),
        onBotUserId: (uid) => this.router.setBotUserId(a.botId, uid),
        onChannelsChanged: (channels) => this.reportChannels({ botId: a.botId, channels }),
        agents: () => this.router.get(a.botId)?.agents ?? [],
        currentOwner: (channelId) => this.router.channelOwner(a.botId, channelId),
        onSetChannelAgent: (channelId, agentId) => this.deps.setChannelAgent(a.botId, channelId, agentId),
        onSelectThreadAgent: (channelId, threadTs, agentId) =>
          this.selectThreadAgent(a.botId, channelId, threadTs, agentId),
        onSessionAction: (action) => this.forwardSessionAction(a.botId, action),
        onSessionShortcut: (shortcut) => this.forwardSessionShortcut(a.botId, shortcut),
        onBotRevoked: (reason, eventAtMs) => {
          this.deps.log.warn(`relay-ingress(${a.botId}): workspace revoked the app (${reason})`)
          // Echo the generation this assignment carries + when Slack says the
          // event happened: the CP refuses the report if a re-install has since
          // replaced the credential (lifecycle events are not ordered).
          this.reportRevoked({
            botId: a.botId,
            reason,
            ...(a.credentialRevision !== undefined ? { credentialRevision: a.credentialRevision } : {}),
            ...(eventAtMs !== undefined ? { eventAtMs } : {})
          })
        },
        log: this.deps.log
      }
    )
    this.ingests.set(a.botId, ingest)
    await ingest.start()
  }

  /** `rc/routes` — hot-update routes/members/default WITHOUT re-opening the ingest. */
  updateRoutes(
    botId: string,
    patch: Pick<
      BotAssignment,
      | 'members'
      | 'agents'
      | 'routes'
      | 'defaultAgentId'
      | 'defaultDaemonId'
      | 'gatedAgentIds'
      | 'mutedChannels'
      | 'gatedOffChannels'
      | 'noticeAuthority'
      | 'noticedDmConversations'
    >
  ): void {
    // A changed gated member set may require a fresh DM fan-out (§14.3) — e.g. a
    // newly restricted or newly installed member needs its own pending Off row.
    const prev = this.router.get(botId)?.gatedAgentIds ?? []
    const next = patch.gatedAgentIds ?? []
    if (prev.length !== next.length || !prev.every((id) => next.includes(id))) this.clearGatedDmLatches(botId)
    this.router.updateRoutes(botId, patch)
  }

  /** `rc/bot-unassign` — drop the routes + close the ingest. */
  async unassign(botId: string, credentialRevision?: number): Promise<void> {
    // A revocation stamps the generation it revoked. If this pod already holds a
    // NEWER assignment, the release describes a credential that has since been
    // replaced — the CP decided and broadcast in that order, and a re-install's
    // assign can overtake it. Dropping the stale release here is what keeps a
    // live ingest alive; an unstamped release (transport flip, uninstall, last
    // install removed) is unconditional as before.
    const held = this.router.get(botId)?.credentialRevision
    if (credentialRevision !== undefined && held !== undefined && held > credentialRevision) {
      this.deps.log.warn(`relay-ingress(${botId}): ignoring stale unassign (rev ${credentialRevision} < held ${held})`)
      return
    }
    this.clearGatedDmLatches(botId)
    this.forgetAppTeam(botId)
    this.forgetFeishuApp(botId)
    this.router.remove(botId)
    await this.stopIngest(botId)
  }

  /** Drop the bot's composite demux entry (assign-derived, so eagerly cleaned —
   *  unlike the learned app-only map, whose stale entries lazily miss). */
  private forgetAppTeam(botId: string): void {
    const key = this.appTeamKeyByBot.get(botId)
    if (key === undefined) return
    this.appTeamKeyByBot.delete(botId)
    if (this.demuxByAppTeam.get(key) === botId) this.demuxByAppTeam.delete(key)
  }

  private forgetFeishuApp(botId: string): void {
    const appId = this.feishuAppIdByBot.get(botId)
    if (!appId) return
    this.feishuAppIdByBot.delete(botId)
    if (this.feishuBotByAppId.get(appId) === botId) this.feishuBotByAppId.delete(appId)
  }

  /** `rc/assign` — durable thread affinity seed. */
  setAffinity(botId: string, sessionKey: string, tgt: RouteTarget): void {
    this.router.setAffinity(botId, sessionKey, tgt)
  }

  /**
   * Demux + authenticate one inbound Slack HTTP POST to its bot's ingest. Slack's
   * HMAC (over the raw body, keyed by the bot's signing secret) authenticates, but
   * it can only DISCRIMINATE while signing secrets differ — every install of a
   * distributed app shares one secret, so those bots resolve exclusively on the
   * composite `(api_app_id, team_id)` index and are skipped by the verify-scan
   * (a scan hit against a sibling install would leak one workspace's messages
   * into another tenant's bot). Legacy bots keep the learned app-only fast path
   * with the verify-scan fallback. `undefined` ⇒ the route answers 401.
   */
  resolveVerified(args: {
    apiAppId?: string
    teamId?: string
    timestamp: string | undefined
    rawBody: Buffer
    signature: string | undefined
  }): SlackHttpIngest | undefined {
    const now = this.deps.clock.now()
    const { apiAppId, teamId, timestamp, rawBody, signature } = args
    // Composite fast path — assign-derived, so a hit is exact (still HMAC-verified).
    if (apiAppId && teamId) {
      const botId = this.demuxByAppTeam.get(appTeamKey(apiAppId, teamId))
      const ingest = botId ? this.ingests.get(botId) : undefined
      if (ingest && verifySlackSignature(ingest.signingSecret, timestamp, rawBody, signature, now)) return ingest
    }
    if (apiAppId) {
      const botId = this.demuxByApiApp.get(apiAppId)
      const ingest = botId ? this.ingests.get(botId) : undefined
      if (ingest && verifySlackSignature(ingest.signingSecret, timestamp, rawBody, signature, now)) return ingest
    }
    for (const [botId, ingest] of this.ingests) {
      // A team-scoped bot may only serve its own workspace: same-secret siblings
      // would all verify, so the envelope team id is the ONLY discriminator.
      const assignedTeam = this.router.get(botId)?.teamId
      if (assignedTeam !== undefined && assignedTeam !== teamId) continue
      if (verifySlackSignature(ingest.signingSecret, timestamp, rawBody, signature, now)) {
        // Learn only the app-only mapping; composite entries are assign-derived.
        if (apiAppId && assignedTeam === undefined) this.rememberApiApp(apiAppId, botId)
        return ingest
      }
    }
    return undefined
  }

  /** Demux + authenticate one Feishu callback. Unencrypted v2 callbacks carry
   *  `header.app_id` for O(1) lookup; encrypted callbacks are verified/decrypted
   *  against the bounded active assignment set because the outer body has no id. */
  resolveFeishuVerified(args: {
    appId?: string
    rawBody: Buffer
    body: unknown
    headers: import('./feishu-http-ingest.js').FeishuCallbackHeaders
  }): FeishuVerifiedDelivery | undefined {
    if (args.appId) {
      const botId = this.feishuBotByAppId.get(args.appId)
      const ingest = botId ? this.feishuIngests.get(botId) : undefined
      const callback = ingest?.decode(args.rawBody, args.body, args.headers)
      if (ingest && callback) return { ingest, callback }
    }
    for (const ingest of this.feishuIngests.values()) {
      const callback = ingest.decode(args.rawBody, args.body, args.headers)
      if (callback) return { ingest, callback }
    }
    return undefined
  }

  private rememberApiApp(apiAppId: string, botId: string): void {
    if (this.demuxByApiApp.size >= MAX_DEMUX_ENTRIES) this.demuxByApiApp.clear()
    this.demuxByApiApp.set(apiAppId, botId)
  }

  /** Test/inspection view of the demux indexes (no secret material). */
  get demuxIndexes(): { byApiApp: ReadonlyMap<string, string>; byAppTeam: ReadonlyMap<string, string> } {
    return { byApiApp: this.demuxByApiApp, byAppTeam: this.demuxByAppTeam }
  }

  /** Make the inline selector effective for the current Slack thread immediately.
   *  The CP channel-owner update remains the durable/default side of the same choice;
   *  local affinity closes the gap for ordinary, un-mentioned follow-up messages. */
  private selectThreadAgent(botId: string, channelId: string, threadTs: string, agentId: string): void {
    const route = this.router.targetForAgentId(botId, agentId)
    if (!route) {
      this.deps.log.warn(`relay-ingress(${botId}): ignored stale thread-agent selection for agent ${agentId}`)
      return
    }
    const sessionKey = sessionKeyOf({ channel: channelId, thread: threadTs })
    this.router.setChannelOwner(botId, channelId, route)
    this.router.setAffinity(botId, sessionKey, route)
    this.deps.setChannelAgent(botId, channelId, agentId)
    // Report the explicit Switch-agent so the CP persists + broadcasts the new owner.
    this.report({ botId, sessionKey, agentId: route.agentId, daemonId: route.daemonId })
  }

  /** Close every ingest (relay shutdown). */
  async stopAll(): Promise<void> {
    if (this.revokeRetryTimer) {
      clearTimeout(this.revokeRetryTimer)
      this.revokeRetryTimer = undefined
    }
    await Promise.all(
      [...new Set([...this.ingests.keys(), ...this.feishuIngests.keys()])].map((id) => this.stopIngest(id))
    )
  }

  private async stopIngest(botId: string): Promise<void> {
    const cur = this.ingests.get(botId)
    if (cur) {
      this.ingests.delete(botId)
      await cur.stop()
    }
    this.feishuIngests.delete(botId)
  }

  private isAgentBotMessage(botId: string, msg: import('@agentconnect.md/protocol').WireNormalizedMessage): boolean {
    const appId = msg.sender.appId
    if (msg.platform !== 'slack' || !msg.sender.isBot || !appId) return false
    return (
      this.router
        .get(botId)
        ?.agents.some((agent) => this.deps.isAgentBotApp(agent.agentId, msg.platform, msg.channel, appId)) ?? false
    )
  }

  /**
   * The §6 ladder for an AgentConnect-authored platform message, on the relay side
   * (send-message-routing-rework.md §4, §4.1 step 4, §6, §8.2).
   *
   * It is a separate ladder rather than a rung of `forward`'s because the checks differ,
   * not because the rungs do: §2.3 gives a response that names nobody the SAME arbitration
   * a human message gets, with the author excluded. What stays exclusive to the verified
   * recipient set is a response that DID name someone — that one activates the named
   * agents or nobody, never a substitute.
   *
   * Note that a bare shared-bot mention resolves to nobody on the author's side, so it
   * arrives here as an unnamed response and continues through the implicit ladder.
   *
   * Anything not routable is dropped rather than forwarded. The relay holds no transcript
   * — "transcript only" is a daemon-side state — and §5.7 already has the target
   * reconstruct preceding text through the ordinary thread-history catch-up path.
   */
  private async forwardVerifiedAgentMessage(
    botId: string,
    msg: import('@agentconnect.md/protocol').WireNormalizedMessage
  ): Promise<void> {
    const claim = msg.agentAuthorship
    const drop = (why: string): void => {
      this.deps.log.debug(`relay-ingress(${botId}): agent-authored ${msg.msgId} not routed (${why})`)
    }
    // Only a FINAL event routes: a streaming post may hold a prefix of the answer (§5.4).
    if (!claim || claim.deliveryState !== 'final') return drop('not a finalized response')
    const appId = msg.sender.appId
    if (!appId) return drop('no sending app identity')
    // §4 condition 3 — the claimed author must be one of the agents THIS app represents
    // in THIS conversation. A shared app backs several agents, so "the app is ours" alone
    // would let one of its tenants author messages as any of the others.
    if (!this.deps.isAgentBotApp(claim.authorAgentId, msg.platform, msg.channel, appId)) {
      return drop(`author ${claim.authorAgentId} is not backed by app ${appId} here`)
    }
    // §4.1 rule 1 — an unverifiable source depth is never coerced to zero; that would
    // hand a runaway mention chain a fresh loop-protection budget on every hop.
    if (!Number.isInteger(claim.hopCount) || claim.hopCount < 0) return drop('unverifiable source hop depth')
    // §4.1 step 4 — the relay performs the identical addition and cap check the daemon
    // would, ONCE, and forwards the result. The target terminal-verifies its range and
    // installs it WITHOUT incrementing again.
    const trustedDeliveryHopCount = claim.hopCount + 1
    if (trustedDeliveryHopCount > MAX_AGENT_CALL_HOPS) {
      return drop(`hop_limit: ${claim.hopCount} + 1 exceeds ${MAX_AGENT_CALL_HOPS}`)
    }
    // §2.3: an agent message that names nobody still continues the conversation — it goes
    // through the SAME arbitration a human message does, with the author excluded so it
    // cannot wake itself. `arbitrate` normally stops bot traffic at the explicit-mention
    // rung; a VERIFIED author is a known participant with a checked policy, not anonymous
    // bot traffic, so it is allowed past.
    //
    // "Names nobody" is judged BEFORE the author is filtered out. A response that did name
    // an agent has explicitly addressed the conversation, so it gets an explicit outcome
    // or none: retargeting it because the named agent is unreachable would substitute a
    // recipient the author never asked for, and filtering first would make a self-mention
    // — the one name every response can produce — indistinguishable from naming nobody.
    const named = claim.mentionedAgentIds.length > 0
    let targets = claim.mentionedAgentIds.filter((id) => id !== claim.authorAgentId)
    let routeVia: 'mention' | 'implicit' = 'mention'
    if (!named) {
      const implicit = this.router.routeAgentAuthored(botId, msg, claim.authorAgentId)
      if (!implicit) return drop('no implicit rung matched')
      targets = [implicit.agentId]
      routeVia = 'implicit'
    }
    if (targets.length === 0) return drop('named only its own author')

    for (const targetAgentId of targets) {
      // Every listed author→target edge is checked independently and against the RELAY's
      // own snapshot — the recipient set is a provider claim until each edge passes
      // current policy and the conversation gate (§5, closing paragraph).
      const route = this.router.agentTarget(botId, targetAgentId, msg.channel)
      if (!route) {
        drop(`target ${targetAgentId} is not a member of this bot`)
        continue
      }
      if (!this.deps.admitsAgentCall(claim.authorAgentId, targetAgentId)) {
        drop(`call policy excludes ${claim.authorAgentId} -> ${targetAgentId}`)
        continue
      }
      const daemon = this.deps.getDaemon(route.daemonId)
      if (!daemon) {
        const n = (this.dropped.get(botId) ?? 0) + 1
        this.dropped.set(botId, n)
        this.deps.log.warn(`relay-ingress(${botId}): daemon ${route.daemonId} offline — dropped (total ${n})`)
        continue
      }
      const rd: RdMsgIm = {
        source: 'im',
        agentId: route.agentId,
        sessionKey: sessionKeyOf(msg),
        // Namespace by target: one visible post may address several agents, and each is
        // its own delivery. A shared msgId would make the target daemons' dedup collapse
        // them into one and silently drop every recipient but the first.
        msgId: `${msg.msgId}#${route.agentId}`,
        botId,
        integrationId: route.integrationId,
        chatId: msg.channel,
        payload: msg,
        // §8.2: the relay's MINTED assertions, outside `payload` so the target can always
        // tell them apart from the provider fields it must not trust.
        trustedFromAgentId: claim.authorAgentId,
        trustedResponseId: claim.responseId,
        trustedRecipientAgentIds: [route.agentId],
        ...(claim.agentCallDeliveryId ? { trustedAgentCallDeliveryId: claim.agentCallDeliveryId } : {}),
        trustedDeliveryHopCount,
        // The target cannot re-derive this: it sees one pre-addressed agent either way.
        // Without it every implicit continuation would arrive looking like an explicit
        // mention and would clear a `!stop` mute.
        trustedRouteVia: routeVia
      }
      try {
        await daemon.sendMsg(rd)
        this.deps.log.info(
          `relay-ingress(${botId}): agent-authored mention ${claim.authorAgentId} -> ${route.agentId} (hop ${trustedDeliveryHopCount})`
        )
      } catch (err) {
        const n = (this.dropped.get(botId) ?? 0) + 1
        this.dropped.set(botId, n)
        this.deps.log.warn(
          `relay-ingress(${botId}): forward to ${route.daemonId} failed: ${(err as Error).message} (dropped ${n})`
        )
      }
    }
  }

  /** Arbitrate + forward one message to its daemon (never throws — bounded loss).
   *  Reports a first-route/changed affinity to the CP, and on a genuine un-mentioned
   *  thread follow-up with no local affinity, pulls the persisted owner from the CP. */
  private async forward(botId: string, msg: import('@agentconnect.md/protocol').WireNormalizedMessage): Promise<void> {
    // send-message-routing-rework.md §2.3/§6: agent-authored traffic takes its OWN
    // ladder and never continues into the human one. Handled BEFORE arbitration for the
    // same reason the blanket filter used to be: an agent's platform copy must not mutate
    // thread affinity or produce a CP assignment report on its way through.
    if (this.isAgentBotMessage(botId, msg)) {
      await this.forwardVerifiedAgentMessage(botId, msg)
      return
    }
    const sessionKey = sessionKeyOf(msg)
    const assignment = this.router.get(botId)
    const hasGatedMembers = (assignment?.gatedAgentIds?.length ?? 0) > 0
    // §14.3 DM discovery must NOT depend on the arbitration outcome: on a
    // mixed-visibility bot the public default agent wins every unslugged DM, yet
    // the gated installs still need their pending Off row to ever be enableable.
    // A group DM is discovered the same way — Slack never lists one as membership, so
    // an unreported one could never be enabled. It is only ever *addressed* by mention,
    // so unlike a DM it is reported only when it names THIS bot: `mentionedBots` also
    // holds the humans and other apps named in the same message.
    const namesThisBot = assignment?.botUserId !== undefined && msg.mentionedBots.includes(assignment.botUserId)
    const addressesBot = msg.isDm || (msg.isGroupDm === true && namesThisBot)
    if (addressesBot && !msg.sender.isBot && hasGatedMembers) await this.reportGatedConversation(botId, msg)
    const prior = this.router.peekAffinity(botId, sessionKey)
    let tgt = this.router.route(botId, msg)
    if (tgt) {
      // Report leg: first route of this thread, or the arbitrated owner changed —
      // EXCEPT for an `auto`-owned channel, where every message (incl. follow-ups)
      // re-resolves via the channel rung on any pod, so the binding is never consulted
      // (reporting it would only amplify writes + grow shared_thread_agent unboundedly).
      const changed = !prior || prior.agentId !== tgt.agentId || prior.daemonId !== tgt.daemonId
      if (changed && !this.router.channelAutoOwned(botId, msg.channel)) {
        this.report({ botId, sessionKey, agentId: tgt.agentId, daemonId: tgt.daemonId })
      }
    } else {
      // Conversation gating (resource-visibility §14.3): an explicitly-addressed
      // message (DM, or @bot mention) that arbitration could not place, on a bot
      // that backs ≥1 gated agent, must not look silently dead — answer once per
      // conversation (the DM row itself was already reported above, un-gated on
      // the routing outcome).
      //
      // Every Off channel arrives here unroutable, and the two kinds answer
      // differently. A channel an OPERATOR silenced says nothing: they already
      // decided, and "ask an admin to enable it" would be the opposite of what
      // happened. A channel that is Off because §14 never enabled its gated owner
      // still speaks once — the person asking had no way to know the agent is
      // private. Only ownership separates them (they share a trigger value), so the
      // CP marks the gated ones and the fence and the notice stay independent.
      const muted = this.router.channelMuted(botId, msg.channel)
      const speaks = !muted || this.router.channelGatedOff(botId, msg.channel)
      if (!msg.sender.isBot && hasGatedMembers && speaks) {
        const mentioned = assignment?.botUserId !== undefined && msg.mentionedBots.includes(assignment.botUserId)
        if (msg.isDm || mentioned) {
          // Feishu callback credentials are receive-only. For its currently
          // single-install HTTP bot, hand the addressed Off-conversation event to
          // the owning daemon: the daemon reports discovery, posts through its API
          // client, and drops before agent dispatch. Slack keeps its existing
          // relay-owned notice path because that ingest already owns bot egress.
          if (assignment?.platform === 'feishu') tgt = this.router.soleGatedTarget(botId) ?? null
          if (!tgt) {
            await this.noticeGatedUnrouted(botId, msg)
            return
          }
        }
      }
      // Backstop leg: only a real un-mentioned threaded follow-up is worth a CP lookup.
      if (!tgt) {
        if (!this.router.isUnmentionedThreadFollowup(botId, msg)) return
        let target: { agentId: string; daemonId: string } | null
        try {
          target = (await this.deps.lookupThread({ botId, sessionKey })).target
        } catch {
          return // CP down — drop (bounded loss); a mention re-anchors the thread.
        }
        if (!target) {
          this.router.rememberNoAffinity(botId, sessionKey)
          return
        }
        // Seeded from the CP — do NOT report it back (it came from the CP).
        if (!this.router.seedLookupTarget(botId, sessionKey, target)) return
        tgt = this.router.route(botId, msg)
        if (!tgt) return
      }
    }
    const daemon = this.deps.getDaemon(tgt.daemonId)
    if (!daemon) {
      const n = (this.dropped.get(botId) ?? 0) + 1
      this.dropped.set(botId, n)
      this.deps.log.warn(`relay-ingress(${botId}): daemon ${tgt.daemonId} offline — dropped (total ${n})`)
      return
    }
    const rd: RdMsgIm = {
      source: 'im',
      agentId: tgt.agentId,
      sessionKey: sessionKeyOf(msg),
      msgId: msg.msgId,
      botId,
      integrationId: tgt.integrationId,
      chatId: msg.channel,
      payload: msg
    }
    try {
      await daemon.sendMsg(rd)
    } catch (err) {
      const n = (this.dropped.get(botId) ?? 0) + 1
      this.dropped.set(botId, n)
      this.deps.log.warn(
        `relay-ingress(${botId}): forward to ${tgt.daemonId} failed: ${(err as Error).message} (dropped ${n})`
      )
    }
  }

  /**
   * §14.3: surface one human direct conversation to the CP as an incremental
   * `kind:'im'` / `kind:'mpim'` report (fanned to gated installs as pending Off rows —
   * the console enablement path). Fires for EVERY human DM on a bot with gated members,
   * routed or not, and for an addressed group DM; latched per conversation per relay
   * lifetime (the CP upsert is idempotent, this only bounds chatter — a relay restart
   * re-reports harmlessly). Channel rows need no report here — membership snapshots
   * already carry them, and neither of these kinds appears in one.
   */
  private async reportGatedConversation(botId: string, msg: WireNormalizedMessage): Promise<void> {
    const latch = `${botId}:${msg.channel}`
    if (this.gatedDmReported.has(latch)) return
    // A group DM's counterpart is the room, not the sender, so it carries no name here.
    const name = msg.isDm ? await this.ingests.get(botId)?.lookupUserName(msg.sender.id) : undefined
    const sent = this.deps.reportBotConversation({
      botId,
      conversation: { id: msg.channel, ...(name ? { name } : {}), kind: msg.isDm ? 'im' : 'mpim' }
    })
    // Latch only a delivered report — a CP-link-down drop retries on the next DM.
    if (sent) this.gatedDmReported.add(latch)
  }

  /** §14.3: the ONE-TIME per-conversation notice for an explicitly-addressed,
   *  unroutable message on a bot with gated members — the bot must never look
   *  silently broken. */
  private async noticeGatedUnrouted(botId: string, msg: WireNormalizedMessage): Promise<void> {
    // Once-per-conversation cannot rest on replica-local state, and the CP must
    // never be a per-message round-trip (daemon-centric boundary) — so both
    // arbitration inputs are data-plane state stamped on the assignment:
    //  • CHANNEL mentions arrive as TWO event copies that may land on different
    //    pods → only the deterministic noticeAuthority pod posts (whichever copy
    //    reaches it first; the local latch collapses siblings). A mention whose
    //    copies miss the authority is caught by the next one; no authority ⇒ no
    //    pod posts.
    //  • DMs have a SINGLE event copy → the RECEIVING pod posts, gated by the
    //    noticedDmConversations set — DELIVERED notices only (reported below via
    //    rc/notice-posted and re-stamped pool-wide by the CP), never mere row
    //    discovery: a mixed bot's DM routed by its public default creates a row
    //    without a notice, and must still get one if it later becomes
    //    unroutable. (A second DM inside the re-stamp window may double —
    //    KNOWN, low-severity.)
    const a = this.router.get(botId)
    if (msg.isDm) {
      if (a?.noticedDmConversations?.includes(msg.channel)) return
    } else {
      const authority = a?.noticeAuthority
      if (!authority || authority !== this.deps.selfRelayId()) return
    }
    const key = `${botId}:${msg.channel}`
    if (this.gatedNoticesSent.has(key)) return
    const ingest = this.ingests.get(botId)
    // Feishu relay ingress is receive-only. Its caller first tries the assignment
    // directory's sole gated daemon target; an old CP that did not include the
    // integration id safely lands here and drops instead of leaking API secrets.
    if (!ingest) return
    this.gatedNoticesSent.add(key)
    try {
      await ingest.postText(
        msg.channel,
        '🔒 This agent isn’t enabled in this conversation. Ask an admin to enable it in the AgentConnect console.',
        msg.isDm ? undefined : msg.thread
      )
      // Pool-wide DM latch = DELIVERY, reported after the post succeeds.
      if (msg.isDm) this.deps.reportNoticePosted({ botId, channel: msg.channel })
    } catch (err) {
      this.deps.log.warn(
        `relay-ingress(${botId}): gating notice failed in ch=${msg.channel}: ${(err as Error).message}`
      )
    }
  }

  /** Forward an HTTP Slack status-modal action to the exact agent that rendered
   *  the button. This intentionally does not use channel ownership: the operator may
   *  click an older Bob session after switching the channel default to Alice. */
  private forwardSessionAction(botId: string, action: HttpSlackSessionAction): void {
    const { target, interactionId: _interactionId, userId, ...payload } = action
    const route = this.router.targetForAgent(botId, target.agentId, target.integrationId)
    if (!route) {
      this.deps.log.warn(`relay-ingress(${botId}): ignored stale session action for agent ${target.agentId}`)
      return
    }
    const daemon = this.deps.getDaemon(route.daemonId)
    if (!daemon) {
      this.deps.log.warn(`relay-ingress(${botId}): daemon ${route.daemonId} offline — session action dropped`)
      return
    }
    // §6.6 emission flip: the relay now speaks the platform_action envelope —
    // the daemon's per-platform decoder validates the opaque payload against
    // Slack's own wire schema (gate 2 closed: the fleet reads it since #521).
    const rd: RdMsgPlatformAction = {
      source: 'platform_action',
      platformId: 'slack',
      agentId: route.agentId,
      integrationId: route.integrationId,
      sessionKey: target.sessionKey,
      msgId: httpSlackActionMsgId(botId, action),
      botId,
      ...(userId ? { userId } : {}),
      payload
    }
    void daemon
      .sendMsg(rd)
      .then((ack) => {
        if (!ack.accepted)
          this.deps.log.warn(`relay-ingress(${botId}): daemon rejected session action (${ack.reason ?? 'unknown'})`)
      })
      .catch((err) =>
        this.deps.log.warn(`relay-ingress(${botId}): session action forward failed: ${(err as Error).message}`)
      )
  }

  /** Forward one verified Lark / Feishu card callback to the sole integration that
   * rendered it. The daemon resolves the provider message id against its local
   * active-card map and returns the callback response for the HTTP edge. */
  private async forwardFeishuAction(
    botId: string,
    action: WireFeishuCardActionEvent,
    eventId: string | undefined
  ): Promise<WireFeishuCardActionResponse | undefined> {
    const value = WireFeishuCardActionValue.safeParse(action.action?.value)
    const route =
      value.success && value.data.target
        ? this.router.integrationTarget(botId, value.data.target.agentId, value.data.target.integrationId)
        : this.router.soleTarget(botId)
    if (!route) {
      this.deps.log.warn(`relay-ingress(${botId}): Feishu card action has no current integration target`)
      return undefined
    }
    const daemon = this.deps.getDaemon(route.daemonId)
    if (!daemon) {
      this.deps.log.warn(`relay-ingress(${botId}): daemon ${route.daemonId} offline — Feishu action dropped`)
      return undefined
    }
    const messageId = action.context?.open_message_id ?? action.open_message_id
    if (!messageId) return undefined
    const msgId = httpFeishuActionMsgId(botId, eventId, action)
    const rd: RdMsgPlatformAction = {
      source: 'platform_action',
      platformId: 'feishu',
      agentId: route.agentId,
      integrationId: route.integrationId,
      sessionKey: `feishu-action:${messageId}`,
      msgId,
      botId,
      payload: action
    }
    try {
      const ack = await daemon.sendMsg(rd)
      if (!ack.accepted) {
        this.deps.log.warn(`relay-ingress(${botId}): daemon rejected Feishu card action (${ack.reason ?? 'unknown'})`)
      }
      // §6.6: a fleet daemon answers a platform_action with the generic opaque
      // `response`; the Feishu-named slot is read as a tolerance fallback until
      // the deprecated rd/ack member retires with the legacy readers.
      const generic = WireFeishuCardActionResponse.safeParse(ack.response)
      return generic.success && ack.response !== undefined ? generic.data : ack.feishuCardAction
    } catch (err) {
      this.deps.log.warn(`relay-ingress(${botId}): Feishu card action forward failed: ${(err as Error).message}`)
      return undefined
    }
  }

  /** Resolve a message shortcut from live conversation ownership, then let the
   *  daemon resolve the exact bot-scoped session before it opens the modal. */
  private forwardSessionShortcut(botId: string, shortcut: HttpSlackSessionShortcut): boolean {
    const sessionKey = sessionKeyOf({ channel: shortcut.channelId, thread: shortcut.threadTs })
    const assignment = this.router.get(botId)
    if (!assignment) return false
    // A channel switched Off takes no shortcut either — the modal it opens acts on a
    // session in a conversation the operator has silenced.
    if (assignment.mutedChannels?.includes(shortcut.channelId)) return false
    const allowedInChannel = (agentId: string): boolean =>
      !assignment.gatedAgentIds?.includes(agentId) ||
      assignment.routes.some((route) => route.agentId === agentId && route.scope?.channel === shortcut.channelId)
    const affinity = this.router.peekAffinity(botId, sessionKey)
    const affinityRoute =
      affinity && allowedInChannel(affinity.agentId)
        ? this.router.targetForAgent(botId, affinity.agentId, affinity.integrationId)
        : undefined
    const channelOwner = this.router.channelOwner(botId, shortcut.channelId)
    const route =
      affinityRoute ??
      (channelOwner && allowedInChannel(channelOwner)
        ? this.router.targetForAgentId(botId, channelOwner)
        : undefined) ??
      (assignment.defaultAgentId && allowedInChannel(assignment.defaultAgentId)
        ? this.router.targetForAgentId(botId, assignment.defaultAgentId)
        : undefined)
    if (!route) return false
    const daemon = this.deps.getDaemon(route.daemonId)
    if (!daemon) return false
    const rd: RdMsgPlatformAction = {
      source: 'platform_action',
      platformId: 'slack',
      agentId: route.agentId,
      integrationId: route.integrationId,
      sessionKey,
      msgId: httpSlackShortcutMsgId(botId, shortcut),
      botId,
      ...(shortcut.userId ? { userId: shortcut.userId } : {}),
      payload: {
        kind: 'open-config-for-thread',
        triggerId: shortcut.triggerId,
        channelId: shortcut.channelId,
        threadTs: shortcut.threadTs
      }
    }
    void daemon
      .sendMsg(rd)
      .then((ack) => {
        if (!ack.accepted)
          this.deps.log.warn(`relay-ingress(${botId}): daemon rejected session shortcut (${ack.reason ?? 'unknown'})`)
      })
      .catch((err) =>
        this.deps.log.warn(`relay-ingress(${botId}): session shortcut forward failed: ${(err as Error).message}`)
      )
    return true
  }
}
