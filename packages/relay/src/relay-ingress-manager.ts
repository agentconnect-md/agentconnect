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
import {
  hasReachedAgentCallHopLimit,
  MAX_AGENT_CALL_HOPS,
  RD_AGENT_IMPLICIT_ROUTING_V1,
  RD_ACK_NOT_HOLDER
} from '@agentconnect.md/protocol'
import type {
  RdMsg,
  RdAck,
  RdMsgIm,
  RcBotChannels,
  RcBotConversation,
  RcBotRevoked,
  WireNormalizedMessage,
  RcThreadAssign,
  RcThreadParticipant,
  RcThreadLookup
} from '@agentconnect.md/protocol'
import type { Clock } from '@agentconnect.md/connection'
import type { Logger } from './log.js'
import { BotArbitrationRouter, sessionKeyOf, type BotAssignment, type RouteTarget } from './bot-arbitration.js'
import { DemuxIndex, IngressPool, relayIngressPlugins } from './platforms/registry.js'
import type {
  HandledDelivery,
  RelayBotIngress,
  RelayIngressHost,
  RelayIngressSidecar,
  RelayPlatformIngressPlugin
} from './platforms/contract.js'
import { SlackEventDedup } from './slack-event-dedup.js'
import type { RelayDaemonConnection } from './relay-daemon-connection.js'

/** Cap on the learned `api_app_id → botId` demux index before it is flushed. */
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
  /** Report one observed direct conversation to the CP (→ `rc/bot-conversation`).
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
  /** Persist one joined participant without changing the compatibility owner. */
  reportThreadParticipant: (m: RcThreadParticipant) => boolean
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

/** One registered platform's live state: its plugin, its pool of per-bot
 *  ingests, and its demux identity index. The pool holds ONLY ingests this
 *  plugin built, which is what lets core hand a pooled ingest straight back to
 *  `plugin.verify` / `plugin.handle` through the erased `RelayBotIngress`
 *  bound — core never reads a `TIngest`'s internals (§8). */
interface RelayPlatformEntry {
  plugin: RelayPlatformIngressPlugin
  pool: IngressPool<RelayBotIngress>
  demux: DemuxIndex
}

export class RelayIngressManager {
  private readonly router = new BotArbitrationRouter()
  /**
   * §8 registry (S3): one entry per REGISTERED platform — its plugin, one pool
   * of per-bot ingests, and one demux identity index. Adding a platform adds
   * one line to `platforms/registry.ts`; no method here grows a branch, and no
   * method here names a platform.
   *
   * Every lifecycle edge reads this map: assign builds through it, inbound
   * demuxes through it, and teardown/shutdown iterate it (audit F2/F3/F4 —
   * before that, three of them named `slackPool`/`feishuPool` directly and a
   * third platform's ingest was never stopped, its pool entry never dropped,
   * and its demux entries never forgotten).
   *
   * The index owns the composite/app-only decision per ASSIGNMENT shape
   * (tenant-scoped ⇒ composite only, never learned; app-only ⇒ learnable) —
   * see platforms/registry.ts.
   */
  private readonly ingressPlugins: ReadonlyMap<string, RelayPlatformEntry>
  /** Core's side of the §8 contract — what a plugin's ingest may call back
   *  into. Every member maps onto the same manager/router machinery the
   *  pre-plugin callbacks used; nothing here is platform-shaped. */
  private get ingressHost(): RelayIngressHost {
    return (this.ingressHostMemo ??= this.buildIngressHost())
  }
  private ingressHostMemo?: RelayIngressHost
  private buildIngressHost(): RelayIngressHost {
    return {
      forward: (botId, message, sidecar) => this.forward(botId, message, sidecar),
      forwardAction: async (msg, route) => {
        // An interaction is as pre-addressed as an `rd/msg` and its recorded member is
        // as likely to have handed the duty on, so it takes the SAME rendezvous path:
        // one `not_holder` re-route, and a refusal counted as the drop it is.
        const context = `relay-ingress(${msg.botId}) interaction`
        const daemon = this.deps.getDaemon(route.daemonId)
        if (!daemon) {
          return this.dropUnrouted(msg.botId, `${context}: daemon ${route.daemonId} is not on this relay`, {
            msgId: msg.msgId,
            accepted: false,
            reason: 'offline'
          })
        }
        return this.sendWithRendezvous(daemon, msg, msg.botId, context)
      },
      reportChannels: (snapshot) => this.reportChannels(snapshot),
      reportRevoked: (botId, reason, eventAtMs, credentialRevision) => {
        // The revision is the OBSERVING assignment's, captured by the plugin at
        // buildIngest — never the mutable current one, which a fire-and-forget
        // older ingest could otherwise use to revoke a replacement credential.
        this.reportRevoked({
          botId,
          reason: reason as 'app_uninstalled' | 'tokens_revoked',
          ...(credentialRevision !== undefined ? { credentialRevision } : {}),
          ...(eventAtMs !== undefined ? { eventAtMs } : {})
        })
      },
      directory: {
        agents: (botId) => this.router.get(botId)?.agents ?? [],
        channelOwner: (botId, channelId) => this.router.channelOwner(botId, channelId),
        targetForAgentId: (botId, agentId) => this.router.targetForAgentId(botId, agentId),
        resolveTarget: (botId, coords) => this.resolveConversationTarget(botId, coords),
        conversationParticipants: (botId, coords) =>
          this.router.conversationParticipants(
            botId,
            sessionKeyOf({ channel: coords.channelId, thread: coords.threadTs }),
            coords.channelId
          ),
        targetForAgent: (botId, agentId, integrationId) => this.router.targetForAgent(botId, agentId, integrationId),
        integrationTarget: (botId, agentId, integrationId) =>
          this.router.integrationTarget(botId, agentId, integrationId),
        soleTarget: (botId) => this.router.soleTarget(botId)
      },
      dedupSeen: (identity) => this.eventDedup.seen(identity),
      canDeliver: (route) => this.deps.getDaemon(route.daemonId) !== undefined,
      setChannelAgent: (botId, channelId, agentId) => this.deps.setChannelAgent(botId, channelId, agentId),
      selectThreadAgent: (botId, channelId, threadTs, agentId) =>
        this.selectThreadAgent(botId, channelId, threadTs, agentId),
      reportBotUserId: (botId, botUserId) => this.router.setBotUserId(botId, botUserId),
      clock: { now: () => this.deps.clock.now() },
      log: this.deps.log
    }
  }

  /** Event-identity dedup — the CORE-owned table of §8's split (the plugin
   *  mints the identity). One table serves every platform's pool; identities
   *  are platform-prefixed by construction (their envelope fields differ). */
  private get eventDedup(): SlackEventDedup {
    return (this.eventDedupMemo ??= new SlackEventDedup(this.deps.clock))
  }
  private eventDedupMemo?: SlackEventDedup

  /** Bounded-loss counters (per bot) — messages dropped because no daemon connection. */
  private readonly dropped = new Map<string, number>()
  /** Thread-assign reports dropped because the CP link wasn't READY, keyed
   *  `botId\0sessionKey` (latest target wins). Re-emitted on reconnect via
   *  {@link flushPendingReports}; without this a report lost during a CP blip would
   *  never persist and un-mentioned follow-ups on other pods would drop permanently. */
  private readonly pendingReports = new Map<string, RcThreadAssign>()
  private readonly pendingParticipantReports = new Map<string, RcThreadParticipant>()
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
  /** Per-conversation direct-report latch (`botId:channel`) — scoped to the CURRENT
   *  bot assignment. Rows belong to the installs of that moment. */
  private readonly observedConversationsReported = new Set<string>()

  private clearConversationReportLatches(botId: string): void {
    const prefix = `${botId}:`
    for (const k of [...this.observedConversationsReported]) {
      if (k.startsWith(prefix)) this.observedConversationsReported.delete(k)
    }
  }

  /**
   * @param plugins The platform set this manager serves. Defaults to the static
   *   registry — production never passes it. Tests inject a synthetic platform
   *   to prove the lifecycle is registry-driven rather than slack+feishu-shaped,
   *   which is the only way to catch an F2/F3/F4 regression: a suite built from
   *   the two real platforms passes against the hand-named version too.
   */
  constructor(
    private readonly deps: RelayIngressManagerDeps,
    plugins: readonly RelayPlatformIngressPlugin[] = relayIngressPlugins
  ) {
    this.ingressPlugins = new Map(
      plugins.map((plugin) => [
        plugin.platformId,
        { plugin, pool: new IngressPool<RelayBotIngress>(plugin.platformId), demux: new DemuxIndex() }
      ])
    )
  }

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

  private reportParticipant(botId: string, sessionKey: string, target: RouteTarget): void {
    const report: RcThreadParticipant = {
      botId,
      sessionKey,
      agentId: target.agentId,
      daemonId: target.daemonId
    }
    const key = `${botId}\u0000${sessionKey}\u0000${target.agentId}`
    if (this.deps.reportThreadParticipant(report)) this.pendingParticipantReports.delete(key)
    else {
      if (this.pendingParticipantReports.size >= MAX_PENDING_REPORTS) this.pendingParticipantReports.clear()
      this.pendingParticipantReports.set(key, report)
    }
  }

  private reportHumanParticipant(
    botId: string,
    sessionKey: string,
    channel: string,
    primary: RouteTarget | null,
    target: RouteTarget
  ): void {
    // A non-auto primary is persisted by the legacy owner report, whose CP handler
    // also records it as a participant. Auto channels deliberately skip owner
    // affinity, so their participant membership still needs its own durable report.
    if (
      primary?.agentId === target.agentId &&
      primary.daemonId === target.daemonId &&
      !this.router.channelAutoOwned(botId, channel)
    ) {
      return
    }
    this.reportParticipant(botId, sessionKey, target)
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
    for (const [key, m] of [...this.pendingParticipantReports]) {
      if (!this.deps.reportThreadParticipant(m)) break
      this.pendingParticipantReports.delete(key)
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
    // A full (re)assignment can mean new installs. Stale report latches would starve
    // a later install of its own configurable direct row.
    this.clearConversationReportLatches(a.botId)
    this.router.upsert(a)
    // Rebuild the ingest (secrets or transport may have rotated). Idempotent.
    await this.stopIngest(a.botId)
    this.forgetDemux(a.botId)

    // §8 plugin registry: the platform's plugin validates the assignment shape
    // and builds the per-bot ingest; the demux index derives the identity scope
    // from the assignment itself. An unregistered platform is refused with the
    // same warn-and-skip the old else arm carried.
    const entry = this.ingressPlugins.get(a.platform)
    if (!entry) {
      this.deps.log.warn(`relay-ingress(${a.botId}): platform '${a.platform}' ingest not yet supported (milestone C)`)
      return
    }
    const ingest = entry.plugin.buildIngest(a, this.ingressHost)
    if (!ingest) return
    entry.pool.set(a.botId, ingest)
    entry.demux.indexAssign(a.botId, {
      ...(a.apiAppId ? { appId: a.apiAppId } : {}),
      ...(a.teamId ? { tenantId: a.teamId } : {})
    })
    await (ingest as { start?: () => Promise<void> }).start?.()
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
    // A changed install set needs a fresh fan-out so every member gets the row.
    const prev = (this.router.get(botId)?.agents ?? []).map((agent) => agent.integrationId ?? agent.agentId).sort()
    const next = (patch.agents ?? []).map((agent) => agent.integrationId ?? agent.agentId).sort()
    if (prev.length !== next.length || !prev.every((id, index) => id === next[index])) {
      this.clearConversationReportLatches(botId)
    }
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
    this.clearConversationReportLatches(botId)
    this.forgetDemux(botId)
    this.router.remove(botId)
    await this.stopIngest(botId)
  }

  /** `rc/assign` — durable thread affinity seed. */
  setAffinity(botId: string, sessionKey: string, tgt: RouteTarget): void {
    this.router.setAffinity(botId, sessionKey, tgt)
  }

  /** `rc/participant-assign` — durable conversation-member seed. */
  setParticipant(botId: string, sessionKey: string, tgt: RouteTarget): void {
    this.router.setParticipant(botId, sessionKey, tgt)
  }

  /**
   * §8 verify → handle: demux one inbound HTTP delivery to its bot,
   * authenticate through the platform plugin, and hand the TYPED verified
   * product to the plugin's handler. `undefined` ⇒ no assigned bot owns the
   * delivery (the route answers 401).
   *
   * Core drives the ladder — assignment-derived index fast paths (composite
   * exact first, then app-only), then the bounded scan the assignment's
   * identity scope permits: a tenant-scoped bot may only serve its own tenant,
   * because same-secret siblings would all verify and the envelope tenant id
   * is the ONLY discriminator. The plugin owns the cryptography and everything
   * after authentication.
   */
  async handleInbound(
    platformId: string,
    rawBody: Buffer,
    body: unknown,
    headers: Record<string, string | string[] | undefined>
  ): Promise<HandledDelivery | undefined> {
    const entry = this.ingressPlugins.get(platformId)
    if (!entry) return undefined
    const { plugin, pool, demux } = entry
    const now = this.deps.clock.now()
    const hints = plugin.extractDemuxHints(rawBody, body, headers)
    const tryCandidate = (botId: string | undefined) => {
      const ingest = botId ? pool.get(botId) : undefined
      if (!ingest || !this.tenantFencePasses(botId!, hints.tenantId)) return undefined
      const verified = plugin.verify(ingest, rawBody, body, headers, now)
      return verified === undefined ? undefined : { ingest, verified }
    }
    // Composite fast path — assign-derived, so a hit is exact (still verified).
    let hit = hints.appId && hints.tenantId ? tryCandidate(demux.resolve(hints)) : undefined
    hit ??= hints.appId ? tryCandidate(demux.resolve({ appId: hints.appId })) : undefined
    if (!hit) {
      for (const [botId, ingest] of pool.entries()) {
        if (!this.tenantFencePasses(botId, hints.tenantId)) continue
        const verified = plugin.verify(ingest, rawBody, body, headers, now)
        if (verified !== undefined) {
          // Learn only the app-only mapping; the index itself refuses a
          // tenant-scoped bot (registry.test.ts), keeping the invariant even if
          // a future call site forgets this assignment check. What a learned
          // entry can serve is bounded by the fence above, which is re-applied
          // on every resolve through `tryCandidate`.
          if (hints.appId && this.router.get(botId)?.teamId === undefined) demux.learn(hints.appId, botId)
          hit = { ingest, verified }
          break
        }
      }
    }
    if (!hit) return undefined
    return entry.plugin.handle(hit.ingest, hit.verified, this.ingressHost)
  }

  /**
   * The ingress tenant fence (ingress-tenant-fence.md §3): may a delivery from
   * `deliveryTenant` be attributed to this bot at all?
   *
   * `plugin.verify` proves a delivery was signed with an app's signing secret —
   * NOT that it came from the workspace this assignment belongs to. Those are
   * different questions whenever one app's credentials live in two
   * organizations, and a signature scan answers only the first. So every rung
   * of the ladder asks this one before it accepts a candidate.
   *
   * The fence refuses only a PROVABLE mismatch — both sides must know a tenant
   * (§3.3). An assignment whose tenant was never captured keeps today's
   * behaviour and converges once the CP's identity reconciler backfills it; a
   * delivery naming no tenant keeps today's behaviour too, and cannot be
   * steered at a chosen victim in the first place.
   */
  private tenantFencePasses(botId: string, deliveryTenant: string | undefined): boolean {
    const assignment = this.router.get(botId)
    // Distributed install (`teamId` set): STRICT — same-app siblings share the
    // signing secret, the envelope tenant id is the only discriminator, and a
    // delivery that names no tenant has no safe owner among them. This arm
    // preserves the pre-fence scan guard's fail-closed semantics exactly.
    if (assignment?.teamId !== undefined) return assignment.teamId === deliveryTenant
    // Every other install kind (`workspaceId` when captured): refuse only a
    // PROVABLE mismatch — both sides must know a tenant (§3.3 fail-open arms:
    // an uncaptured identity keeps today's behaviour until the reconciler
    // backfills it; a tenant-less delivery keeps today's behaviour too).
    const workspace = assignment?.workspaceId
    if (workspace === undefined || deliveryTenant === undefined) return true
    return workspace === deliveryTenant
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

  /** Close every ingest (relay shutdown) — across every REGISTERED platform,
   *  not the union of two named pools (audit F4). */
  async stopAll(): Promise<void> {
    if (this.revokeRetryTimer) {
      clearTimeout(this.revokeRetryTimer)
      this.revokeRetryTimer = undefined
    }
    const bots = new Set<string>()
    for (const { pool } of this.ingressPlugins.values()) for (const [botId] of pool.entries()) bots.add(botId)
    await Promise.all([...bots].map((id) => this.stopIngest(id)))
  }

  /** The bot's live ingest, found through its ASSIGNMENT's platform entry —
   *  the §8 read that replaced "which map the bot lives in" acting as the
   *  platform test. Undefined when the bot has no assignment or no built ingest. */
  private ingestFor(botId: string): RelayBotIngress | undefined {
    const platform = this.router.get(botId)?.platform
    const entry = platform ? this.ingressPlugins.get(platform) : undefined
    return entry?.pool.get(botId)
  }

  /**
   * Tear `botId`'s ingest down wherever it lives (audit F2).
   *
   * EVERY pool is asked rather than the one its assignment names, and that is
   * required, not defensive: `unassign` removes the routing entry BEFORE
   * calling this, so by now there is no assignment left to look the platform up
   * from. It is also what the two hand-named pools did, in this same order.
   *
   * Per pool the order is unchanged — drop the entry FIRST, then stop — so a
   * concurrent inbound delivery can never demux onto an ingest that is closing.
   * "Nothing to stop, only to drop" stopped being core's business here: it is
   * `RelayBotIngress.stop()`'s, and a pure decoder implements it as a no-op.
   */
  /**
   * Send one pre-addressed item, honouring the activation rendezvous: a daemon
   * that does not hold the target agent's duty answers `not_holder` naming the
   * member that does, and the trigger is re-sent there ONCE (design §4.4). The
   * msgId is reused verbatim so the true holder's own dedup still protects
   * against a double delivery, and a second refusal terminates rather than
   * chasing a stale ledger.
   *
   * Messages AND platform interactions ride it: both are addressed from the same
   * routing projection, so a button click goes stale exactly the way an
   * un-mentioned follow-up does.
   *
   * A refusal this cannot resolve — no holder named, the holder not connected
   * to THIS relay, or the redirect target refusing in turn — is a genuinely
   * dropped trigger, counted like any other drop. There is deliberately no
   * claim of a retry behind it: HTTP ingress has already acknowledged and
   * deduplicated the provider callback by this point, so nothing upstream will
   * present the message again. Bounding that window is the CP's job (the
   * ledger's vacancy sweep), not the router's.
   */
  private async sendWithRendezvous(
    daemon: RelayDaemonConnection,
    rd: RdMsg,
    botId: string,
    context: string
  ): Promise<RdAck> {
    const ack = await daemon.sendMsg(rd)
    if (ack.accepted || ack.reason !== RD_ACK_NOT_HOLDER) return ack
    const holderId = ack.holderDaemonId
    if (!holderId) return this.dropUnrouted(botId, `${context}: not_holder named no duty holder`, ack)
    const holder = this.deps.getDaemon(holderId)
    if (!holder) return this.dropUnrouted(botId, `${context}: duty holder ${holderId} is not on this relay`, ack)
    this.deps.log.info(`${context}: re-routing to duty holder ${holderId}`)
    const second = await holder.sendMsg(rd)
    if (!second.accepted && second.reason === RD_ACK_NOT_HOLDER) {
      return this.dropUnrouted(botId, `${context}: duty holder ${holderId} refused in turn`, second)
    }
    return second
  }

  /** Count and log a trigger the rendezvous could not place. */
  private dropUnrouted(botId: string, message: string, ack: RdAck): RdAck {
    const n = (this.dropped.get(botId) ?? 0) + 1
    this.dropped.set(botId, n)
    this.deps.log.warn(`${message} (dropped ${n})`)
    return ack
  }

  private async stopIngest(botId: string): Promise<void> {
    for (const { pool } of this.ingressPlugins.values()) {
      const cur = pool.get(botId)
      if (!cur) continue
      pool.delete(botId)
      await cur.stop()
    }
  }

  /** Drop every demux entry for `botId`, through the registry rather than a
   *  hand list of two (audit F3). A surviving composite entry is exactly the
   *  cross-tenant delivery hazard {@link DemuxIndex} exists to prevent, so no
   *  platform may be left out of the sweep; `forget` evicts BOTH the composite
   *  entry and every app-only entry pointing at the bot. */
  private forgetDemux(botId: string): void {
    for (const { demux } of this.ingressPlugins.values()) demux.forget(botId)
  }

  private isAgentBotMessage(botId: string, msg: import('@agentconnect.md/protocol').WireNormalizedMessage): boolean {
    // The sender's platform APP identity is the capability signal: only
    // platforms whose normalizers attribute one (Slack's api_app_id) can be
    // checked against the CP's agent-bot index, and the index lookup itself is
    // platform-keyed — a platform with no entries answers false (fail closed).
    const appId = msg.sender.appId
    if (!msg.sender.isBot || !appId) return false
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
   * It is separate from `forward` because every author→target edge carries additional
   * security and loop-control state: verified authorship, directional policy, one hop,
   * and a durable activation claim. Ordinary arbitration may nominate a primary, but it
   * does not bound delivery: existing participants and newly joined mention matches are
   * forwarded independently, including when they live on different daemons. The paired
   * `toAgent + channel` observation remains the only exact-target exception.
   *
   * Anything not routable is dropped rather than forwarded. The relay holds no transcript
   * — "transcript only" is a daemon-side state — and §5.7 already has the target
   * reconstruct preceding text through the ordinary thread-history catch-up path.
   */
  private async forwardVerifiedAgentMessage(
    botId: string,
    msg: import('@agentconnect.md/protocol').WireNormalizedMessage,
    sidecar?: RelayIngressSidecar
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
    if (hasReachedAgentCallHopLimit(trustedDeliveryHopCount)) {
      return drop(`hop_limit: ${claim.hopCount} + 1 reaches ${MAX_AGENT_CALL_HOPS}`)
    }
    // The recipient set the author resolved is NOT consulted for delivery: a verified
    // agent message goes to whoever this bot's ordinary arbitration selects, the author
    // excluded. `arbitrate` normally stops bot traffic at the explicit-mention rung; a
    // VERIFIED author is a known participant with a checked policy, not anonymous bot
    // traffic, so it is allowed past.
    //
    // Selecting by mention made delivery depend on resolving a `<@U…>` through the
    // collaboration directory, so an unresolvable token silenced the conversation rather
    // than merely costing precision. Peers are meant to see what was said and judge for
    // themselves; every edge below is still checked against this relay's own snapshot.
    //
    // ONE exception, and it is not an address: the visible half of a paired
    // `toAgent + channel` send. Its target came from the tool call as an agent id, never
    // from parsing text, and the rendezvous only converges when this observation and the
    // internal wake name the SAME target — arbitration could pick the channel's default
    // or thread owner instead, recording the observation against an agent the wake never
    // mentions and stranding both halves. The daemon path special-cases it identically.
    const paired = claim.agentCallDeliveryId !== undefined
    let deliveries: Array<{ targetAgentId: string; routeVia: 'mention' | 'implicit' }>
    if (paired) {
      const targets = claim.mentionedAgentIds
      if (targets.length === 0) return drop('paired agent call named no agent')
      deliveries = targets.map((targetAgentId) => ({ targetAgentId, routeVia: 'mention' }))
    } else {
      const primary = this.router.routeAgentAuthored(botId, msg, claim.authorAgentId)
      deliveries = this.router
        .conversationTargets(
          botId,
          msg,
          primary,
          claim.authorAgentId,
          claim.mentionedAgentIds,
          (target) => this.reportParticipant(botId, sessionKeyOf(msg), target),
          (target) => this.deps.admitsAgentCall(claim.authorAgentId, target.agentId)
        )
        .map(({ target, via }) => ({ targetAgentId: target.agentId, routeVia: via }))
      if (deliveries.length === 0) return drop('no participant admitted for this bot')
    }

    for (const { targetAgentId, routeVia } of deliveries) {
      // Every author→target edge is checked independently and against the RELAY's own
      // snapshot, regardless of whether arbitration, participation, or a join found it.
      const route = this.router.agentTarget(botId, targetAgentId, msg.channel)
      if (!route) {
        drop(`target ${targetAgentId} is not a member of this bot`)
        continue
      }
      const pairedSelfObservation = paired && claim.authorAgentId === targetAgentId
      if (!pairedSelfObservation && !this.deps.admitsAgentCall(claim.authorAgentId, targetAgentId)) {
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
      // §8.4, fail closed: a daemon that predates `trustedRouteVia` reads every
      // agent-authored delivery as an explicit mention, which CLEARS a `!stop` mute.
      // Forwarding an implicit continuation to it during a mixed-version rollout would
      // silently disable the one control a human has over a runaway exchange. Refusing
      // degrades to the pre-change behavior instead, which is merely less conversational.
      if (routeVia === 'implicit' && !daemon.supports(RD_AGENT_IMPLICIT_ROUTING_V1)) {
        drop(`daemon ${route.daemonId} predates implicit agent routing`)
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
        // Beside the payload, never inside it: the target persists `payload` to its durable
        // inbox, and this is a credential (see RelayIngressSidecar).
        ...(sidecar?.searchActionToken ? { searchActionToken: sidecar.searchActionToken } : {}),
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
        await this.sendWithRendezvous(daemon, rd, botId, `relay-ingress(${botId})`)
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
  private async forward(
    botId: string,
    msg: import('@agentconnect.md/protocol').WireNormalizedMessage,
    sidecar?: RelayIngressSidecar
  ): Promise<void> {
    // send-message-routing-rework.md §2.3/§6: agent-authored traffic takes its OWN
    // ladder and never continues into the human one. Handled BEFORE arbitration for the
    // same reason the blanket filter used to be: an agent's platform copy must not mutate
    // thread affinity or produce a CP assignment report on its way through.
    if (this.isAgentBotMessage(botId, msg)) {
      await this.forwardVerifiedAgentMessage(botId, msg, sidecar)
      return
    }
    const sessionKey = sessionKeyOf(msg)
    const assignment = this.router.get(botId)
    const hasGatedMembers = (assignment?.gatedAgentIds?.length ?? 0) > 0
    // Direct-conversation discovery must NOT depend on arbitration: every install
    // needs its own visible trigger row, whether the message routes or not.
    // A group DM is discovered the same way — Slack never lists one as membership, so
    // an unreported one could never be enabled. It is only ever *addressed* by mention,
    // so unlike a DM it is reported only when it names THIS bot: `mentionedBots` also
    // holds the humans and other apps named in the same message.
    const namesThisBot = assignment?.botUserId !== undefined && msg.mentionedBots.includes(assignment.botUserId)
    const addressesBot = msg.isDm || (msg.isGroupDm === true && namesThisBot)
    if (addressesBot && !msg.sender.isBot) await this.reportObservedConversation(botId, msg)
    const prior = this.router.peekAffinity(botId, sessionKey)
    let tgt = this.router.route(botId, msg)
    // Third-party bots retain their strict explicit-mention-only behavior. Participant
    // fan-out is for humans and verified AgentConnect authors; treating an arbitrary bot
    // like a person in the room would let one mention wake unrelated joined agents.
    let conversationTargets =
      msg.sender.isBot && tgt
        ? [{ target: tgt, via: 'mention' as const }]
        : this.router.conversationTargets(botId, msg, tgt, undefined, [], (target) =>
            this.reportHumanParticipant(botId, sessionKey, msg.channel, tgt, target)
          )
    if (tgt) {
      // Report leg: first route of this thread, or the arbitrated owner changed —
      // EXCEPT for an `auto`-owned channel, where every message (incl. follow-ups)
      // re-resolves via the channel rung on any pod, so the binding is never consulted
      // (reporting it would only amplify writes + grow shared_thread_agent unboundedly).
      const changed = !prior || prior.agentId !== tgt.agentId || prior.daemonId !== tgt.daemonId
      if (changed && !this.router.channelAutoOwned(botId, msg.channel)) {
        this.report({ botId, sessionKey, agentId: tgt.agentId, daemonId: tgt.daemonId })
      }
    }
    if (!tgt && conversationTargets.length === 0) {
      // Conversation gating (resource-visibility §14.3): an explicitly-addressed
      // message (DM, or @bot mention) that arbitration could not place, on a bot
      // that backs ≥1 gated agent, must not look silently dead — answer once per
      // conversation (the DM row itself was already reported above, independently
      // of the routing outcome).
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
          // §8 relayOwnsEgress, derived from the egress FACET: an ingest without
          // one (Feishu — its callback credentials are receive-only) hands the
          // addressed Off-conversation event to the owning daemon, which reports
          // discovery, posts through its API client, and drops before agent
          // dispatch. An ingest WITH the facet (Slack) keeps the relay-owned
          // notice path below.
          if (!this.ingestFor(botId)?.egress) tgt = this.router.soleGatedTarget(botId) ?? null
          if (!tgt) {
            await this.noticeGatedUnrouted(botId, msg)
            return
          }
        }
      }
      // Backstop leg: only a real un-mentioned threaded follow-up is worth a CP lookup.
      if (!tgt) {
        if (!this.router.isUnmentionedThreadFollowup(botId, msg)) return
        let lookup: Awaited<ReturnType<RelayIngressManagerDeps['lookupThread']>>
        try {
          lookup = await this.deps.lookupThread({ botId, sessionKey })
        } catch {
          return // CP down — drop (bounded loss); a mention re-anchors the thread.
        }
        for (const participant of lookup.participants) {
          const current = this.router.agentTarget(botId, participant.agentId, msg.channel)
          if (current && current.daemonId === participant.daemonId) {
            this.router.setParticipant(botId, sessionKey, current)
          }
        }
        if (!lookup.target && lookup.participants.length === 0) {
          this.router.rememberNoAffinity(botId, sessionKey)
          return
        }
        // Seeded from the CP — do NOT report it back (it came from the CP).
        if (lookup.target) {
          if (!this.router.seedLookupTarget(botId, sessionKey, lookup.target)) return
          tgt = this.router.route(botId, msg)
        }
        conversationTargets = msg.sender.isBot
          ? tgt
            ? [{ target: tgt, via: 'mention' }]
            : []
          : this.router.conversationTargets(botId, msg, tgt, undefined, [], (target) =>
              this.reportHumanParticipant(botId, sessionKey, msg.channel, tgt, target)
            )
        if (!tgt && conversationTargets.length === 0) return
      }
    }
    // A single-owner route is only the compatibility/reporting primary. Delivery is to
    // every participant, including joined agents on other daemons. Each copy carries its
    // own trusted cause so a human mention clears only the named target's `!stop`; peers
    // hearing the same body remain implicit even though it contains that mention token.
    if (conversationTargets.length === 0 && tgt) {
      conversationTargets = msg.sender.isBot
        ? [{ target: tgt, via: 'mention' }]
        : this.router.conversationTargets(botId, msg, tgt, undefined, [], (target) =>
            this.reportHumanParticipant(botId, sessionKey, msg.channel, tgt, target)
          )
      // Receive-only Feishu may intentionally hand an explicitly addressed Off event to
      // its sole gated daemon even though that target has no servable route. The daemon
      // records discovery and posts the notice; its terminal gate still prevents a turn.
      if (conversationTargets.length === 0) conversationTargets = [{ target: tgt, via: 'mention' }]
    }
    for (const { target: participant, via } of conversationTargets) {
      const daemon = this.deps.getDaemon(participant.daemonId)
      if (!daemon) {
        const n = (this.dropped.get(botId) ?? 0) + 1
        this.dropped.set(botId, n)
        this.deps.log.warn(`relay-ingress(${botId}): daemon ${participant.daemonId} offline — dropped (total ${n})`)
        continue
      }
      if (
        via === 'implicit' &&
        (conversationTargets.length > 1 || namesThisBot) &&
        !daemon.supports(RD_AGENT_IMPLICIT_ROUTING_V1)
      ) {
        this.deps.log.debug(`relay-ingress(${botId}): daemon ${participant.daemonId} predates per-target routing cause`)
        continue
      }
      const rd: RdMsgIm = {
        source: 'im',
        agentId: participant.agentId,
        sessionKey: sessionKeyOf(msg),
        msgId: conversationTargets.length > 1 ? `${msg.msgId}#${participant.agentId}` : msg.msgId,
        botId,
        integrationId: participant.integrationId,
        chatId: msg.channel,
        payload: msg,
        ...(sidecar?.searchActionToken ? { searchActionToken: sidecar.searchActionToken } : {}),
        trustedRouteVia: via
      }
      try {
        await this.sendWithRendezvous(daemon, rd, botId, `relay-ingress(${botId})`)
      } catch (err) {
        const n = (this.dropped.get(botId) ?? 0) + 1
        this.dropped.set(botId, n)
        this.deps.log.warn(
          `relay-ingress(${botId}): forward to ${participant.daemonId} failed: ${(err as Error).message} (dropped ${n})`
        )
      }
    }
  }

  /**
   * Surface one human direct conversation to the CP as an incremental
   * `kind:'im'` / `kind:'mpim'` report, fanned to every install with its visibility-
   * appropriate default. Fires for every human DM, routed or not, and for an addressed
   * group DM; latched per conversation per relay
   * lifetime (the CP upsert is idempotent, this only bounds chatter — a relay restart
   * re-reports harmlessly). Channel rows need no report here — membership snapshots
   * already carry them, and neither of these kinds appears in one.
   */
  private async reportObservedConversation(botId: string, msg: WireNormalizedMessage): Promise<void> {
    const latch = `${botId}:${msg.channel}`
    if (this.observedConversationsReported.has(latch)) return
    // A group DM's counterpart is the room, not the sender, so it carries no name here.
    const name = msg.isDm ? await this.ingestFor(botId)?.egress?.lookupUserName(msg.sender.id) : undefined
    const sent = this.deps.reportBotConversation({
      botId,
      conversation: {
        id: msg.channel,
        ...(name ? { name } : {}),
        // Who the row is with (§14.8) — a 1:1 DM's whole human membership, and what lets
        // the CP seed a gated install's row On for a member the agent is already shared with.
        ...(msg.isDm ? { dmUserId: msg.sender.id } : {}),
        kind: msg.isDm ? 'im' : 'mpim'
      }
    })
    // Latch only a delivered report — a CP-link-down drop retries on the next DM.
    if (sent) this.observedConversationsReported.add(latch)
  }

  /** §14.3: the ONE-TIME per-conversation notice for an explicitly-addressed,
   *  unroutable message on a bot with gated members — the bot must never look
   *  silently broken. */
  private async noticeGatedUnrouted(botId: string, msg: WireNormalizedMessage): Promise<void> {
    // Once-per-conversation cannot rest on replica-local state, and the CP must
    // never be a per-message round-trip (control-plane/data-plane boundary) — so both
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
    const egress = this.ingestFor(botId)?.egress
    // No egress facet (Feishu — receive-only ingress): the caller first tried
    // the assignment directory's sole gated daemon target; an old CP that did
    // not include the integration id safely lands here and drops instead of
    // leaking API secrets.
    if (!egress) return
    this.gatedNoticesSent.add(key)
    try {
      await egress.notice(
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

  /**
   * CORE-owned resolution of bare conversation coordinates to a routable target
   * (§8 directory.resolveTarget): live thread affinity, then channel owner, then
   * the default agent — with the mute and gating fences applied at every rung.
   * Extracted verbatim from the Slack message-shortcut forwarder when it moved
   * into its plugin; the ladder is platform-free arbitration policy.
   */
  private resolveConversationTarget(
    botId: string,
    coords: { channelId: string; threadTs: string }
  ): RouteTarget | undefined {
    const sessionKey = sessionKeyOf({ channel: coords.channelId, thread: coords.threadTs })
    const assignment = this.router.get(botId)
    if (!assignment) return undefined
    // A channel switched Off takes no shortcut either — the modal it opens acts on a
    // session in a conversation the operator has silenced.
    if (assignment.mutedChannels?.includes(coords.channelId)) return undefined
    const allowedInChannel = (agentId: string): boolean =>
      !assignment.gatedAgentIds?.includes(agentId) ||
      assignment.routes.some((route) => route.agentId === agentId && route.scope?.channel === coords.channelId)
    const affinity = this.router.peekAffinity(botId, sessionKey)
    const affinityRoute =
      affinity && allowedInChannel(affinity.agentId)
        ? this.router.targetForAgent(botId, affinity.agentId, affinity.integrationId)
        : undefined
    const channelOwner = this.router.channelOwner(botId, coords.channelId)
    return (
      affinityRoute ??
      (channelOwner && allowedInChannel(channelOwner)
        ? this.router.targetForAgentId(botId, channelOwner)
        : undefined) ??
      (assignment.defaultAgentId && allowedInChannel(assignment.defaultAgentId)
        ? this.router.targetForAgentId(botId, assignment.defaultAgentId)
        : undefined)
    )
  }
}
