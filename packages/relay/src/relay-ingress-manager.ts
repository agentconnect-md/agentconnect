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
import { MAX_AGENT_CALL_HOPS, RD_AGENT_IMPLICIT_ROUTING_V1 } from '@agentconnect.md/protocol'
import type {
  RdMsgIm,
  RcBotChannels,
  RcBotConversation,
  RcBotRevoked,
  WireNormalizedMessage,
  RcThreadAssign,
  RcThreadLookup
} from '@agentconnect.md/protocol'
import type { Clock } from '@agentconnect.md/connection'
import type { Logger } from './log.js'
import { BotArbitrationRouter, sessionKeyOf, type BotAssignment, type RouteTarget } from './bot-arbitration.js'
import { SlackHttpIngest } from './platforms/slack/http-ingest.js'
import { FeishuHttpIngest } from './platforms/feishu/http-ingest.js'
import { DemuxIndex, IngressPool } from './platforms/registry.js'
import type {
  HandledDelivery,
  RelayBotIngress,
  RelayIngressHost,
  RelayPlatformIngressPlugin
} from './platforms/contract.js'
import { SlackEventDedup } from './slack-event-dedup.js'
import { slackIngressPlugin } from './platforms/slack/ingress-plugin.js'
import { feishuIngressPlugin } from './platforms/feishu/ingress-plugin.js'
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

// The interaction dedup-id minters moved into their platform plugins (§8: the
// plugin mints the dedup id; core owns the table). Re-exported for existing
// importers until the route files migrate.
export { httpSlackActionMsgId, httpSlackShortcutMsgId } from './platforms/slack/ingress-plugin.js'
export { httpFeishuActionMsgId } from './platforms/feishu/ingress-plugin.js'

export class RelayIngressManager {
  private readonly router = new BotArbitrationRouter()
  /** §8 registry (S3): one pool of per-bot ingests per platform, and one demux
   *  identity index beside each pool. The index owns the composite/app-only
   *  decision per ASSIGNMENT shape (tenant-scoped ⇒ composite only, never
   *  learned; app-only ⇒ learnable) — see platforms/registry.ts. */
  private readonly slackPool = new IngressPool<SlackHttpIngest>('slack')
  private readonly feishuPool = new IngressPool<FeishuHttpIngest>('feishu')
  private readonly slackDemux = new DemuxIndex()
  private readonly feishuDemux = new DemuxIndex()
  /** §8 plugin registry: adding a platform adds one entry — assign() never
   *  grows a branch. The typed pools above stay for the typed read sites
   *  (resolveVerified pair), aliased into the entries here. */
  private readonly ingressPlugins = new Map<
    string,
    {
      plugin: RelayPlatformIngressPlugin<SlackHttpIngest | FeishuHttpIngest, unknown>
      pool: IngressPool<SlackHttpIngest | FeishuHttpIngest>
      demux: DemuxIndex
    }
  >([
    [
      'slack',
      {
        plugin: slackIngressPlugin as never,
        pool: this.slackPool as IngressPool<SlackHttpIngest | FeishuHttpIngest>,
        demux: this.slackDemux
      }
    ],
    [
      'feishu',
      {
        plugin: feishuIngressPlugin as never,
        pool: this.feishuPool as IngressPool<SlackHttpIngest | FeishuHttpIngest>,
        demux: this.feishuDemux
      }
    ]
  ])
  /** Core's side of the §8 contract — what a plugin's ingest may call back
   *  into. Every member maps onto the same manager/router machinery the
   *  pre-plugin callbacks used; nothing here is platform-shaped. */
  private get ingressHost(): RelayIngressHost {
    return (this.ingressHostMemo ??= this.buildIngressHost())
  }
  private ingressHostMemo?: RelayIngressHost
  private buildIngressHost(): RelayIngressHost {
    return {
      forward: (botId, message) => this.forward(botId, message),
      forwardAction: async (msg, route) => {
        const daemon = this.deps.getDaemon(route.daemonId)
        if (!daemon) {
          this.deps.log.warn(`relay-ingress(${msg.botId}): daemon ${route.daemonId} offline — interaction dropped`)
          return { msgId: msg.msgId, accepted: false, reason: 'offline' }
        }
        return daemon.sendMsg(msg)
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
    this.slackDemux.forget(a.botId)
    this.feishuDemux.forget(a.botId)

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
    this.slackDemux.forget(botId)
    this.feishuDemux.forget(botId)
    this.router.remove(botId)
    await this.stopIngest(botId)
  }

  /** `rc/assign` — durable thread affinity seed. */
  setAffinity(botId: string, sessionKey: string, tgt: RouteTarget): void {
    this.router.setAffinity(botId, sessionKey, tgt)
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
      if (!ingest) return undefined
      const verified = plugin.verify(ingest, rawBody, body, headers, now)
      return verified === undefined ? undefined : { ingest, verified }
    }
    // Composite fast path — assign-derived, so a hit is exact (still verified).
    let hit = hints.appId && hints.tenantId ? tryCandidate(demux.resolve(hints)) : undefined
    hit ??= hints.appId ? tryCandidate(demux.resolve({ appId: hints.appId })) : undefined
    if (!hit) {
      for (const [botId, ingest] of pool.entries()) {
        const assignedTenant = this.router.get(botId)?.teamId
        if (assignedTenant !== undefined && assignedTenant !== hints.tenantId) continue
        const verified = plugin.verify(ingest, rawBody, body, headers, now)
        if (verified !== undefined) {
          // Learn only the app-only mapping; the index itself refuses a
          // tenant-scoped bot (registry.test.ts), keeping the invariant even if
          // a future call site forgets this assignment check.
          if (hints.appId && assignedTenant === undefined) demux.learn(hints.appId, botId)
          hit = { ingest, verified }
          break
        }
      }
    }
    if (!hit) return undefined
    return entry.plugin.handle(hit.ingest, hit.verified, this.ingressHost)
  }

  /** Test/inspection view of the demux indexes (no secret material). */
  get demuxIndexes(): { byApiApp: ReadonlyMap<string, string>; byAppTeam: ReadonlyMap<string, string> } {
    const { byApp, byAppTenant } = this.slackDemux.indexes
    return { byApiApp: byApp, byAppTeam: byAppTenant }
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
      [
        ...new Set([
          ...[...this.slackPool.entries()].map(([id]) => id),
          ...[...this.feishuPool.entries()].map(([id]) => id)
        ])
      ].map((id) => this.stopIngest(id))
    )
  }

  /** The bot's live ingest, found through its ASSIGNMENT's platform entry —
   *  the §8 read that replaced "which map the bot lives in" acting as the
   *  platform test. Undefined when the bot has no assignment or no built ingest. */
  private ingestFor(botId: string): RelayBotIngress | undefined {
    const platform = this.router.get(botId)?.platform
    const entry = platform ? this.ingressPlugins.get(platform) : undefined
    return entry?.pool.get(botId)
  }

  private async stopIngest(botId: string): Promise<void> {
    const cur = this.slackPool.get(botId)
    if (cur) {
      this.slackPool.delete(botId)
      await cur.stop()
    }
    // A Feishu ingest is a pure decoder — nothing to stop, only to drop.
    this.feishuPool.delete(botId)
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
   * It is a separate ladder rather than a rung of `forward`'s because the checks differ,
   * not because the rungs do: §2.3 gives a response that names nobody the SAME arbitration
   * a human message gets, with the author excluded. What stays exclusive to the verified
   * recipient set is a response that DID name someone — that one activates the named
   * agents or nobody, never a substitute.
   *
   * "Named someone" is wider than the resolved agent set. A bare shared-bot mention, a
   * human, or another app all resolve to no agent yet are still deliberate addressing, so
   * they stop here rather than continuing — the same place the direct ladder stops
   * (`routeRules`: an unmatched mention in a channel routes to nobody).
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
      // Naming a HUMAN (or another app, or a bare shared bot) is still deliberate
      // addressing even though it resolves to no agent — `mentionedBots` holds every
      // `<@U…>` token, not only bots. The direct ladder stops there (`routeRules`:
      // unmatched mention in a channel ⇒ no route), for human senders too, so stopping
      // here is what keeps one message from waking a peer over the relay and nobody over
      // a direct connection. A DM is already addressed to its recipient, so it is exempt
      // on both sides.
      // `mentionedBots` is reparsed from the FINAL section's text, so it misses a mention
      // the splitter left in an earlier one; the author's claim covers the complete
      // response and is the only place that fact survives. Either is enough — an address
      // is an address wherever in the answer it appeared.
      if (!msg.isDm && (msg.mentionedBots.length > 0 || claim.addressedAnyone === true)) {
        return drop('addressed someone this relay cannot resolve')
      }
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
    const name = msg.isDm ? await this.ingestFor(botId)?.egress?.lookupUserName(msg.sender.id) : undefined
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
