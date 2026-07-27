/**
 * `SharedBotManager` (shared-bot-relay.md §10 / §12) — glues the CP's shared-bot
 * control frames (`rc/bot-assign` / `rc/bot-unassign` / `rc/routes` / `rc/assign`)
 * to the ingest lifecycle, arbitration ({@link SharedBotRouter}), and forwarding
 * onto the target daemon (`rd/msg` `im`).
 *
 * Flow: `rc/bot-assign` loads the bot's inbound routing + credentials; inbound
 * arrives via the shared HTTP `/slack/events` + `/slack/interactions` routes, which
 * demux to a bot via {@link SharedBotManager.resolveVerified} (Slack HMAC is the
 * authenticator), normalize, arbitrate, and forward to the resolved daemon as a
 * pre-addressed `rd/msg(im)`. A daemon that is offline / has no connection here is a
 * TYPED delivery miss → bounded-loss drop + count (never a silent success, §17).
 *
 * Affinity (§10 step 3, the 3-leg dance): on the FIRST route of a (channel, thread)
 * `sessionKey` (or a Switch-agent) the manager REPORTS it to the CP (`rc/thread-assign`);
 * on an un-mentioned follow-up it has no cached affinity for, it PULLS the persisted
 * owner from the CP (`rc/thread-lookup`) rather than dropping the message.
 */
import { createHash } from 'node:crypto'
import type {
  RdMsgIm,
  RdMsgSlackAction,
  RcBotChannels,
  RcBotConversation,
  WireNormalizedMessage,
  RcThreadAssign,
  RcThreadLookup
} from '@agentconnect.md/protocol'
import type { Clock } from '@agentconnect.md/connection'
import type { Logger } from './log.js'
import { SharedBotRouter, sessionKeyOf, type BotAssignment, type RouteTarget } from './shared-bot-router.js'
import { SlackSharedIngest, type SharedSlackSessionAction } from './slack-shared-ingest.js'
import { verifySlackSignature } from './hooks/signature.js'
import type { RelayDaemonConnection } from './relay-daemon-connection.js'

/** Cap on the learned `api_app_id → botId` demux index before it is flushed. */
const MAX_DEMUX_ENTRIES = 10_000

/** Cap on the retry buffer for thread-assign reports dropped while the CP link was
 *  down. Bounded so a long CP outage can't grow it without limit; oldest-cleared. */
const MAX_PENDING_REPORTS = 10_000

export interface SharedBotManagerDeps {
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
  /** Report the thread's now-resolved owner to the CP (→ `rc/thread-assign`). Returns
   *  `false` if the CP link was not READY and the frame was dropped, so the manager can
   *  retry it when the link recovers ({@link SharedBotManager.flushPendingReports}). */
  reportThreadAssign: (m: RcThreadAssign) => boolean
  /** Pull a thread's persisted owner from the CP on an affinity miss (→ `rc/thread-lookup`). */
  lookupThread: (m: RcThreadLookup) => Promise<import('@agentconnect.md/protocol').RcThreadLookupOk>
  /** True when the sender app backs another AgentConnect agent beside the resolved
   *  target in this channel. Used only to suppress platform activation. */
  isAgentBotApp: (targetAgentId: string, platform: string, channelId: string, appId: string) => boolean
  /** Clock for the inbound Slack HMAC replay window (`resolveVerified`). */
  clock: Clock
  log: Logger
}

/** Stable daemon-side dedup id for one Slack interaction. The hash deliberately omits
 *  open-config's one-shot triggerId (interactionId already identifies that click), so
 *  sensitive trigger material never leaks into logs or dedup keys. */
export function sharedSlackActionMsgId(botId: string, action: SharedSlackSessionAction): string {
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

export class SharedBotManager {
  private readonly router = new SharedBotRouter()
  private readonly ingests = new Map<string, SlackSharedIngest>()
  /** Learned/assigned `api_app_id → botId` index — O(1) HTTP demux (self-populates on
   *  first verified delivery when the CP didn't stamp `apiAppId`). Bounded flush. */
  private readonly demuxByApiApp = new Map<string, string>()
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
  /** §14 one-time gating-notice latch (`botId:channel`) — per relay lifetime.
   *  Two-state: the NON-authoritative event copy shadow-primes `posted:false`
   *  (keyed by msgId) so a LATER mention's authoritative copy landing on THIS pod
   *  stays silent, while the SAME message's authoritative sibling still posts. */
  private readonly gatedNoticesSent = new Map<string, { msgId: string; posted: boolean }>()
  /** §14.3 per-conversation DM-report latch (`botId:channel`) — scoped to the
   *  CURRENT bot assignment: cleared on assign/unassign and whenever the gated
   *  member set changes, since rows belong to the installs of that moment. */
  private readonly gatedDmReported = new Set<string>()

  private clearGatedDmLatches(botId: string): void {
    const prefix = `${botId}:`
    for (const k of [...this.gatedDmReported]) if (k.startsWith(prefix)) this.gatedDmReported.delete(k)
  }

  constructor(private readonly deps: SharedBotManagerDeps) {}

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

  /** Re-emit reports and channel snapshots dropped while the CP link was down
   *  (wired to the client's onReady). Each queue stops at the first frame that still
   *  can't be sent, keeping the rest. */
  flushPendingReports(): void {
    for (const [key, m] of [...this.pendingReports]) {
      if (!this.deps.reportThreadAssign(m)) break
      this.pendingReports.delete(key)
    }
    for (const [botId, snapshot] of [...this.pendingChannelReports]) {
      if (!this.deps.reportBotChannels(snapshot)) break
      this.pendingChannelReports.delete(botId)
    }
  }

  /** `rc/bot-assign` — (re)load the routing table + (re)build the bot's HTTP ingest. */
  async assign(a: BotAssignment): Promise<void> {
    // A full (re)assignment can mean new installs / a changed gated set — stale
    // DM-report latches would starve a later gated install of its pending row.
    this.clearGatedDmLatches(a.botId)
    this.router.upsert(a)
    if (a.platform !== 'slack') {
      this.deps.log.warn(`shared-bot(${a.botId}): platform '${a.platform}' ingest not yet supported (milestone C)`)
      return
    }
    // Rebuild the ingest (secrets may have rotated). Idempotent: stop any existing.
    await this.stopIngest(a.botId)
    // Deterministic demux when the CP stamped the app id; else the verify-scan learns it.
    if (a.apiAppId) this.rememberApiApp(a.apiAppId, a.botId)
    const ingest = new SlackSharedIngest(
      a.botId,
      { botToken: a.secrets.botToken, signingSecret: a.secrets.signingSecret },
      {
        onMessage: (msg, meta) => this.forward(a.botId, msg, meta),
        onBotUserId: (uid) => this.router.setBotUserId(a.botId, uid),
        onChannelsChanged: (channels) => this.reportChannels({ botId: a.botId, channels }),
        agents: () => this.router.get(a.botId)?.agents ?? [],
        currentOwner: (channelId) => this.router.channelOwner(a.botId, channelId),
        onSetChannelAgent: (channelId, agentId) => this.deps.setChannelAgent(a.botId, channelId, agentId),
        onSelectThreadAgent: (channelId, threadTs, agentId) =>
          this.selectThreadAgent(a.botId, channelId, threadTs, agentId),
        onSessionAction: (action) => this.forwardSessionAction(a.botId, action),
        log: this.deps.log
      }
    )
    this.ingests.set(a.botId, ingest)
    await ingest.start()
  }

  /** `rc/routes` — hot-update routes/members/default WITHOUT re-opening the ingest. */
  updateRoutes(
    botId: string,
    patch: Pick<BotAssignment, 'members' | 'agents' | 'routes' | 'defaultAgentId' | 'defaultDaemonId' | 'gatedAgentIds'>
  ): void {
    // A changed gated member set may require a fresh DM fan-out (§14.3) — e.g. a
    // newly restricted or newly installed member needs its own pending Off row.
    const prev = this.router.get(botId)?.gatedAgentIds ?? []
    const next = patch.gatedAgentIds ?? []
    if (prev.length !== next.length || !prev.every((id) => next.includes(id))) this.clearGatedDmLatches(botId)
    this.router.updateRoutes(botId, patch)
  }

  /** `rc/bot-unassign` — drop the routes + close the ingest. */
  async unassign(botId: string): Promise<void> {
    this.clearGatedDmLatches(botId)
    this.router.remove(botId)
    await this.stopIngest(botId)
  }

  /** `rc/assign` — durable thread affinity seed. */
  setAffinity(botId: string, sessionKey: string, tgt: RouteTarget): void {
    this.router.setAffinity(botId, sessionKey, tgt)
  }

  /**
   * Demux + authenticate one inbound Slack HTTP POST to its bot's ingest. Slack's
   * HMAC (over the raw body, keyed by the bot's signing secret) is BOTH the demux
   * discriminator and the authenticator: a request is only attributed to a bot whose
   * signing secret verifies it. Fast path via the learned `api_app_id` index; on a
   * miss (or absent app id / rotated secret) a verify-scan over every assigned bot
   * finds and caches it. `undefined` ⇒ the route answers 401.
   */
  resolveVerified(args: {
    apiAppId?: string
    teamId?: string
    timestamp: string | undefined
    rawBody: Buffer
    signature: string | undefined
  }): SlackSharedIngest | undefined {
    const now = this.deps.clock.now()
    const { apiAppId, timestamp, rawBody, signature } = args
    if (apiAppId) {
      const botId = this.demuxByApiApp.get(apiAppId)
      const ingest = botId ? this.ingests.get(botId) : undefined
      if (ingest && verifySlackSignature(ingest.signingSecret, timestamp, rawBody, signature, now)) return ingest
    }
    for (const [botId, ingest] of this.ingests) {
      if (verifySlackSignature(ingest.signingSecret, timestamp, rawBody, signature, now)) {
        if (apiAppId) this.rememberApiApp(apiAppId, botId)
        return ingest
      }
    }
    return undefined
  }

  private rememberApiApp(apiAppId: string, botId: string): void {
    if (this.demuxByApiApp.size >= MAX_DEMUX_ENTRIES) this.demuxByApiApp.clear()
    this.demuxByApiApp.set(apiAppId, botId)
  }

  /** Make the inline selector effective for the current Slack thread immediately.
   *  The CP channel-owner update remains the durable/default side of the same choice;
   *  local affinity closes the gap for ordinary, un-mentioned follow-up messages. */
  private selectThreadAgent(botId: string, channelId: string, threadTs: string, agentId: string): void {
    const route = this.router.targetForAgentId(botId, agentId)
    if (!route) {
      this.deps.log.warn(`shared-bot(${botId}): ignored stale thread-agent selection for agent ${agentId}`)
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
    await Promise.all([...this.ingests.keys()].map((id) => this.stopIngest(id)))
  }

  private async stopIngest(botId: string): Promise<void> {
    const cur = this.ingests.get(botId)
    if (cur) {
      this.ingests.delete(botId)
      await cur.stop()
    }
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

  /** Arbitrate + forward one message to its daemon (never throws — bounded loss).
   *  Reports a first-route/changed affinity to the CP, and on a genuine un-mentioned
   *  thread follow-up with no local affinity, pulls the persisted owner from the CP. */
  private async forward(
    botId: string,
    msg: import('@agentconnect.md/protocol').WireNormalizedMessage,
    meta?: { noticeEligible?: boolean }
  ): Promise<void> {
    // Filter before arbitration so a managed agent's platform copy cannot mutate
    // thread affinity or produce a CP assignment report.
    if (this.isAgentBotMessage(botId, msg)) {
      this.deps.log.debug(`shared-bot(${botId}): ignored AgentConnect bot message ${msg.msgId}`)
      return
    }
    const sessionKey = sessionKeyOf(msg)
    const assignment = this.router.get(botId)
    const hasGatedMembers = (assignment?.gatedAgentIds?.length ?? 0) > 0
    // §14.3 DM discovery must NOT depend on the arbitration outcome: on a
    // mixed-visibility bot the public default agent wins every unslugged DM, yet
    // the gated installs still need their pending Off row to ever be enableable.
    if (msg.isDm && !msg.sender.isBot && hasGatedMembers) await this.reportGatedDmConversation(botId, msg)
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
      if (!msg.sender.isBot && hasGatedMembers) {
        const mentioned = assignment?.botUserId !== undefined && msg.mentionedBots.includes(assignment.botUserId)
        if (msg.isDm || mentioned) {
          await this.noticeGatedUnrouted(botId, msg, meta?.noticeEligible !== false)
          return
        }
      }
      // Backstop leg: only a real un-mentioned threaded follow-up is worth a CP lookup.
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
    const daemon = this.deps.getDaemon(tgt.daemonId)
    if (!daemon) {
      const n = (this.dropped.get(botId) ?? 0) + 1
      this.dropped.set(botId, n)
      this.deps.log.warn(`shared-bot(${botId}): daemon ${tgt.daemonId} offline — dropped (total ${n})`)
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
        `shared-bot(${botId}): forward to ${tgt.daemonId} failed: ${(err as Error).message} (dropped ${n})`
      )
    }
  }

  /**
   * §14.3: surface one human DM conversation to the CP as an incremental
   * `kind:'im'` report (fanned to gated installs as pending Off rows — the console
   * enablement path). Fires for EVERY human DM on a bot with gated members,
   * routed or not; latched per conversation per relay lifetime (the CP upsert is
   * idempotent, this only bounds chatter — a relay restart re-reports harmlessly).
   * Channel rows need no report here — membership snapshots already carry them.
   */
  private async reportGatedDmConversation(botId: string, msg: WireNormalizedMessage): Promise<void> {
    const latch = `${botId}:${msg.channel}`
    if (this.gatedDmReported.has(latch)) return
    const name = await this.ingests.get(botId)?.lookupUserName(msg.sender.id)
    const sent = this.deps.reportBotConversation({
      botId,
      conversation: { id: msg.channel, ...(name ? { name } : {}), kind: 'im' }
    })
    // Latch only a delivered report — a CP-link-down drop retries on the next DM.
    if (sent) this.gatedDmReported.add(latch)
  }

  /** §14.3: the ONE-TIME per-conversation notice for an explicitly-addressed,
   *  unroutable message on a bot with gated members — the bot must never look
   *  silently broken. */
  private async noticeGatedUnrouted(botId: string, msg: WireNormalizedMessage, eligible: boolean): Promise<void> {
    // A channel mention arrives as TWO event copies that the pool LB may hand to
    // different pods, so only the authoritative copy is `eligible` to post; the
    // other copy SHADOW-PRIMES this pod's latch (posted:false, keyed by msgId) —
    // the same message's authoritative sibling on this pod still posts, but a
    // LATER mention whose authoritative copy lands here stays silent.
    const key = `${botId}:${msg.channel}`
    const latch = this.gatedNoticesSent.get(key)
    if (!eligible) {
      if (!latch) this.gatedNoticesSent.set(key, { msgId: msg.msgId, posted: false })
      return
    }
    if (latch && (latch.posted || latch.msgId !== msg.msgId)) return
    this.gatedNoticesSent.set(key, { msgId: msg.msgId, posted: true })
    try {
      await this.ingests
        .get(botId)
        ?.postText(
          msg.channel,
          '🔒 This agent isn’t enabled in this conversation. Ask an admin to enable it in the AgentConnect console.',
          msg.isDm ? undefined : msg.thread
        )
    } catch (err) {
      this.deps.log.warn(`shared-bot(${botId}): gating notice failed in ch=${msg.channel}: ${(err as Error).message}`)
    }
  }

  /** Forward a shared Slack status-modal action to the exact agent that rendered
   *  the button. This intentionally does not use channel ownership: the operator may
   *  click an older Bob session after switching the channel default to Alice. */
  private forwardSessionAction(botId: string, action: SharedSlackSessionAction): void {
    const { target, interactionId: _interactionId, userId, ...payload } = action
    const route = this.router.targetForAgent(botId, target.agentId, target.integrationId)
    if (!route) {
      this.deps.log.warn(`shared-bot(${botId}): ignored stale session action for agent ${target.agentId}`)
      return
    }
    const daemon = this.deps.getDaemon(route.daemonId)
    if (!daemon) {
      this.deps.log.warn(`shared-bot(${botId}): daemon ${route.daemonId} offline — session action dropped`)
      return
    }
    const rd: RdMsgSlackAction = {
      source: 'slack_action',
      agentId: route.agentId,
      integrationId: route.integrationId,
      sessionKey: target.sessionKey,
      msgId: sharedSlackActionMsgId(botId, action),
      botId,
      ...(userId ? { userId } : {}),
      payload
    }
    void daemon
      .sendMsg(rd)
      .then((ack) => {
        if (!ack.accepted)
          this.deps.log.warn(`shared-bot(${botId}): daemon rejected session action (${ack.reason ?? 'unknown'})`)
      })
      .catch((err) =>
        this.deps.log.warn(`shared-bot(${botId}): session action forward failed: ${(err as Error).message}`)
      )
  }
}
