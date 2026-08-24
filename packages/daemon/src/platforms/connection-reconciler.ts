/**
 * The daemon-side PLATFORM CONNECTION RECONCILER: the §7.5 lifecycle that converges the
 * live Slack / Telegram / Discord / Feishu clients onto the credentials the current agent
 * roster asks for — open what is missing, prune what nothing references any more, and
 * re-bind the integrations that moved between them. It owns the five connection pools and
 * the Slack startup-retry timers; the per-integration binding maps stay on the Daemon
 * (twenty-odd other call sites read them) and are written through {@link
 * ConnectionReconcilerHost.bindSlack} and friends / `unbindIntegration`.
 *
 * The Daemon keeps thin same-name delegates for everything here, plus getters for the
 * pools, and calls `cancelRetryTimers()` / `dispose()` from `stop()`.
 */
import { randomUUID } from 'node:crypto'
import {
  manifestFor,
  originKindOf,
  type FeishuRegion,
  type IntegrationChannel,
  type IntegrationLeave,
  type IntegrationLeaveOk
} from '@agentconnect.md/protocol'
import { isAlreadyOutOfChat } from '../daemon/helpers.js'
import type { CallMeta } from '../daemon/turn-types.js'
import type { Clock, TimerHandle } from '@agentconnect.md/connection'
import type { Integration } from '../agents/agent-schema.js'
import type { LoadedAgent } from '../agents/load-agents.js'
import type { CpClient } from '../cp/client.js'
import type { Logger } from '../log.js'
import { formatErr } from '../daemon/text.js'
import { buildIntroMessage, planChannelIntros } from '../messages/channel-intro.js'
import type { ChannelNameResolver } from '../messages/channel-name-resolver.js'
import type { NormalizedMessage } from '../messages/normalized.js'
import type { SlackNameResolver } from '../slack/name-resolver.js'
import type { LocalStore } from '../store/local-store.js'
import {
  consolidate,
  consolidateShared,
  slackSharedKey,
  slackSocketKey,
  SlackConnection,
  type SlackAppFactory,
  type SlackDeps
} from '../slack/connection.js'
import {
  consolidateTelegram,
  telegramConnKey,
  TelegramConnection,
  type TelegramCallback,
  type TelegramObservedChat
} from '../telegram/connection.js'
import { consolidateDiscord, discordConnKey, DiscordConnection, type DiscordDeps } from '../discord/connection.js'
import { consolidateFeishu, feishuConnKey, FeishuConnection } from '../feishu/connection.js'
import { ConnectionPool, type ConnectionKey } from './registry.js'

/** Any live platform client this lifecycle opens, prunes or binds. */
export type PlatformConnection = SlackConnection | TelegramConnection | DiscordConnection | FeishuConnection

/**
 * The UI-action callbacks every platform connection is constructed with — a status-bar tap,
 * a permission or elicitation card button, a Telegram callback query, a Discord select, a
 * Slack message shortcut. Grouped as ONE named surface because connection construction is
 * the only place that wires them, and the command handlers that implement them are their
 * own seam: this is the contract between the two, not a bag of loose callbacks.
 */
export interface PlatformActionSink {
  handleStatusAction: NonNullable<SlackDeps['onStatusAction']>
  statusInfoForKey: NonNullable<SlackDeps['onStatusInfo']>
  handlePermissionChoice: NonNullable<SlackDeps['onPermissionChoice']>
  handleElicitChoice: NonNullable<SlackDeps['onElicitChoice']>
  handleDiscordSelect: NonNullable<DiscordDeps['onSelectAction']>
  handleTelegramCallback(cb: TelegramCallback, conn: TelegramConnection): Promise<void>
  slackShortcutSession(
    shortcut: { channel: string; thread: string },
    srcIntegrationIds: readonly string[]
  ): Promise<string | undefined>
}

/** Exactly what the reconciler touches on the Daemon — nothing wider. */
export interface ConnectionReconcilerHost extends PlatformActionSink {
  log(): Logger
  clock(): Clock
  draining(): boolean
  /** True when Bolt's socket-mode internals should be visible (debug/trace logging). */
  boltDebug(): boolean
  /** The test seam that swaps Bolt's App for a fake; undefined in production. */
  slackAppFactory(): SlackAppFactory | undefined
  agents(): Map<string, LoadedAgent>
  /** The roster consolidation counts credentials over — evaluation-owned agents excluded. */
  transportAgents(agents?: LoadedAgent[]): LoadedAgent[]
  /** Virtual integrations that were never opened from credentials, so never evicted. */
  evaluationIntegrationIds(): ReadonlySet<string>
  store(): LocalStore
  cpClient(): CpClient | undefined
  /** The Daemon's cached per-integration channel snapshots, read and written in place. */
  channelSnapshots(): Map<string, { channels: IntegrationChannel[]; authoritative: boolean }>
  /** Every integration with a bot identity on record — the eviction pass's roll call. */
  boundIntegrationIds(): string[]
  /**
   * Read side of the four per-platform binding maps. The reconciler compares against them
   * and sweeps them; every write goes through the `bind*` methods / `unbindIntegration`.
   */
  bindings(): {
    slack: ReadonlyMap<string, SlackConnection>
    telegram: ReadonlyMap<string, TelegramConnection>
    discord: ReadonlyMap<string, DiscordConnection>
    feishu: ReadonlyMap<string, FeishuConnection>
  }
  /** Point an integration at a live connection and record the identity mention-routing
   *  matches — the bot user id on Slack/Discord, the @username on Telegram, the open_id on
   *  Feishu. One per platform, so the binding stays typed and no lookup guesses a map. */
  bindSlack(integrationId: string, conn: SlackConnection, botUserId: string): void
  bindTelegram(integrationId: string, conn: TelegramConnection, botUsername: string): void
  bindDiscord(integrationId: string, conn: DiscordConnection, botUserId: string): void
  bindFeishu(integrationId: string, conn: FeishuConnection, botOpenId: string): void
  /** Drop an integration's connection binding, bot identity and channel snapshot together. */
  unbindIntegration(integrationId: string): void
  slackNameResolver(): SlackNameResolver | undefined
  channelNameResolver(): ChannelNameResolver | undefined
  /** Host hop back into `ConnectionReconciler.refreshChannels` — every internal re-list goes through it so the membership refresh stays one seam. */
  refreshChannels(conn: SlackConnection): Promise<void>
  onInbound(msg: NormalizedMessage, srcIntegrationIds?: string[]): void
  srcIntegrationIds(conn: unknown): string[]
  /** Drain the in-flight turns holding `conn` before it is stopped. */
  waitForConnectionUses(conn: PlatformConnection): Promise<void>
  observeTelegramChat(chat: TelegramObservedChat, integrationIds: readonly string[]): Promise<void>
  refreshObservedChannels(): Promise<void>
  retractChannels(integrationId: string, channelIds: readonly string[]): Promise<void>
  integrationConfigById(integrationId: string): Integration | undefined
  integrationIdForTransportScope(agentId: string, platform: string, transportScope?: string | null): string | undefined
  connForIntegration(integrationId: string): PlatformConnection | undefined
  emitSessionMetadataSnapshotsForDisplayName(id: string): Promise<void>
  dispatch(
    agentId: string,
    msg: NormalizedMessage,
    integrationId: string | undefined,
    callMeta: CallMeta
  ): Promise<string | null>
}

export class ConnectionReconciler {
  // §7.5 connection pools — one per (platform, MODE), each keyed by the platform's
  // own opaque identity function. The pool owns the live set AND the in-flight
  // connect guard: a key is claimed BEFORE `await conn.start()` and released when
  // it resolves or fails, because `find()` only sees a connection after it is
  // added — without the claim, a reconcile overlapping a still-pending connect
  // would open a SECOND connection for the same bot (duplicate inbound delivery).
  // Slack runs two pools: sockets keyed by (appToken, botToken), and send-only
  // shared clients keyed by botToken alone (a shared bot has no app token).
  readonly slackPool = new ConnectionPool<SlackConnection>('slack', slackSocketKey)
  readonly slackSharedPool = new ConnectionPool<SlackConnection>('slack/shared', slackSharedKey)
  readonly telegramPool = new ConnectionPool<TelegramConnection>('telegram', telegramConnKey)
  readonly discordPool = new ConnectionPool<DiscordConnection>('discord', discordConnKey)
  readonly feishuPool = new ConnectionPool<FeishuConnection>('feishu', feishuConnKey)
  // Pending background retry timers for Slack connections that failed to open
  // at startup (keyed by appToken). Cleared on daemon stop.
  private readonly slackRetryTimers = new Map<string, TimerHandle>()
  // A timer callback may already be inside conn.start() when an agent detaches.
  // Track those runs so detach can await them and prevent a stale socket from
  // appearing after its strict close pass has ACKed.
  private readonly slackRetryRuns = new Map<string, { botToken: string; promise: Promise<void> }>()

  constructor(private readonly host: ConnectionReconcilerHost) {}

  private get log(): Logger {
    return this.host.log()
  }

  /** Every pool, for the whole-set pass at shutdown. */
  private pools(): { all(): PlatformConnection[] }[] {
    return [this.slackPool, this.slackSharedPool, this.telegramPool, this.discordPool, this.feishuPool]
  }

  /** The deps every Slack SOCKET shares — the action sink, the name-resolver hand-off and
   *  the membership-snapshot callback. `conn` is a thunk so each callback reads the
   *  connection it was built for, never a stale one from an earlier attempt. */
  private slackSocketDeps(conn: () => SlackConnection): Omit<SlackDeps, 'group'> {
    return {
      newTraceId: () => randomUUID(),
      onMessage: (msg) => {
        this.host.slackNameResolver()?.noteMessage(conn(), msg)
        this.host.onInbound(msg, this.host.srcIntegrationIds(conn()))
      },
      onChannelsChanged: () => void this.host.refreshChannels(conn()),
      onMessageShortcut: (shortcut) => this.host.slackShortcutSession(shortcut, this.host.srcIntegrationIds(conn())),
      onStatusAction: (a) => this.host.handleStatusAction(a),
      onStatusInfo: (key) => this.host.statusInfoForKey(key),
      onPermissionChoice: (a) => this.host.handlePermissionChoice(a),
      onElicitChoice: (a) => this.host.handleElicitChoice(a),
      log: this.log,
      boltDebug: this.host.boltDebug()
    }
  }

  /**
   * Open the consolidated Slack sockets at daemon startup, one per appToken, and bind
   * every integration on that token. A failure does NOT fail boot: the connection is
   * released and a slow background retry is armed, so a temporary outage self-heals.
   */
  async openInitialSlackConnections(agents: LoadedAgent[]): Promise<void> {
    const groups = consolidate(this.host.transportAgents(agents))
    if (groups.size === 0) this.log.info('slack: no slack integrations configured')
    else this.log.info(`slack: opening ${groups.size} socket connection(s)`)
    for (const group of groups.values()) {
      const conn: SlackConnection = new SlackConnection(
        { group, ...this.slackSocketDeps(() => conn) },
        this.host.slackAppFactory()
      )
      this.log.info(
        `slack: connecting (${group.integrations.length} integration(s): ${group.integrations.map((i) => i.agentId).join(', ')})…`
      )
      try {
        await conn.start()
        this.log.info(`slack: socket connected as bot user ${conn.botUserId}`)
        for (const { integrationId } of group.integrations) this.host.bindSlack(integrationId, conn, conn.botUserId)
        this.slackPool.add(conn)
        // Initial membership snapshot (fire-and-forget; cached + emitted when CP is up).
        void this.host.refreshChannels(conn)
      } catch (err) {
        // Release any Bolt SocketModeClient / reconnect loop the half-open connection
        // may have started before we discard it — otherwise a failure during app.start()
        // would leak a live reconnecting client on every attempt of the loop below.
        await conn.stop().catch(() => {})
        this.log.warn(`slack: connection failed for appToken — retrying in 60s: ${formatErr(err)}`)
        // Don't give up; retry in the background at a slow pace so a temporary
        // network outage or Slack API blip self-heals without manual intervention.
        const timer = this.host.clock().setTimeout(() => {
          if (this.host.draining()) return
          this.startSlackRetry(group.appToken)
        }, 60_000)
        this.slackRetryTimers.set(group.appToken, timer)
      }
    }
  }

  /**
   * Close platform clients whose credential key has no reference in the FINAL
   * active-agent roster, and evict every derived index that points at a removed
   * or re-keyed integration. Consolidation maps are the reference counts: direct
   * Slack is keyed by appToken; HTTP Slack, Telegram and Discord by botToken.
   *
   * A captured connection on a live turn is a temporary reference too. Detach
   * drains its own dispatch leases before reaching this method; the guard also
   * keeps ordinary concurrent reconcile safe for unrelated in-flight turns.
   */
  async closeUnusedPlatformConnections(): Promise<void> {
    // Evaluation-owned virtual integrations are invisible to physical reference
    // counting AND immune to eviction (see the guards below): they were never
    // opened from credentials, so credential comparison would always evict them.
    const agents = this.host.transportAgents()
    const direct = consolidate(agents)
    const shared = consolidateShared(agents)
    const telegram = consolidateTelegram(agents)
    const discord = consolidateDiscord(agents)
    const feishu = consolidateFeishu(agents)

    const directByIntegration = new Map<string, { appToken: string; botToken: string }>()
    for (const group of direct.values())
      for (const { integrationId } of group.integrations)
        directByIntegration.set(integrationId, { appToken: group.appToken, botToken: group.botToken })
    const sharedByIntegration = new Map<string, string>()
    for (const group of shared.values())
      for (const { integrationId } of group.integrations) sharedByIntegration.set(integrationId, group.botToken)
    const telegramByIntegration = new Map<string, string>()
    for (const group of telegram.values())
      for (const { integrationId } of group.integrations) telegramByIntegration.set(integrationId, group.botToken)
    const discordByIntegration = new Map<string, string>()
    for (const group of discord.values())
      for (const { integrationId } of group.integrations) discordByIntegration.set(integrationId, group.botToken)
    // Feishu keys on appId (one provider client per self-built app), not a bot token —
    // plus region and mode, so either change produces a different desired connection.
    const feishuByIntegration = new Map<string, string>()
    for (const group of feishu.values())
      for (const { integrationId } of group.integrations) feishuByIntegration.set(integrationId, feishuConnKey(group))

    const allDesiredIds = new Set([
      ...directByIntegration.keys(),
      ...sharedByIntegration.keys(),
      ...telegramByIntegration.keys(),
      ...discordByIntegration.keys(),
      ...feishuByIntegration.keys()
    ])
    const evaluation = this.host.evaluationIntegrationIds()
    const bindings = this.host.bindings()
    // Unbinding drops the connection mapping, the bot identity and the channel
    // snapshot together — the three indexes an evicted integration must leave behind.
    for (const integrationId of this.host.boundIntegrationIds())
      if (!allDesiredIds.has(integrationId) && !evaluation.has(integrationId))
        this.host.unbindIntegration(integrationId)
    for (const integrationId of [...this.host.channelSnapshots().keys()])
      if (!allDesiredIds.has(integrationId) && !evaluation.has(integrationId))
        this.host.unbindIntegration(integrationId)

    for (const [integrationId, conn] of bindings.slack) {
      if (evaluation.has(integrationId)) continue
      const expectedDirect = directByIntegration.get(integrationId)
      const expectedShared = sharedByIntegration.get(integrationId)
      const matches = expectedDirect
        ? conn.appToken === expectedDirect.appToken && conn.botToken === expectedDirect.botToken
        : expectedShared !== undefined
          ? conn.appToken === '' && conn.botToken === expectedShared
          : false
      if (!matches) this.host.unbindIntegration(integrationId)
    }
    for (const [integrationId, conn] of bindings.telegram) {
      if (evaluation.has(integrationId)) continue
      if (conn.botToken !== telegramByIntegration.get(integrationId)) this.host.unbindIntegration(integrationId)
    }
    for (const [integrationId, conn] of bindings.discord) {
      if (evaluation.has(integrationId)) continue
      if (conn.botToken !== discordByIntegration.get(integrationId)) this.host.unbindIntegration(integrationId)
    }
    for (const [integrationId, conn] of bindings.feishu) {
      // Compare appId AND region: a region flip on the same appId must evict the stale
      // mapping here (not only when a replacement start succeeds), so a failed replacement
      // never leaves an integration routed at the stopped old-domain client.
      if (feishuConnKey(conn) !== feishuByIntegration.get(integrationId)) this.host.unbindIntegration(integrationId)
    }

    // A startup retry captures only the stable appToken and re-reads the live
    // group when it fires. Cancel timers for keys whose final reference vanished.
    for (const [appToken, timer] of this.slackRetryTimers) {
      if (direct.has(appToken)) continue
      this.host.clock().clearTimeout(timer)
      this.slackRetryTimers.delete(appToken)
    }
    // Join only attempts whose credential key vanished or changed. An unrelated
    // slow appToken must not block this move; same-key/same-bot attempts re-read
    // the final integration roster themselves before publishing their mapping.
    const retryRuns = [...this.slackRetryRuns]
      .filter(([appToken, run]) => direct.get(appToken)?.botToken !== run.botToken)
      .map(([, run]) => run.promise)
    if (retryRuns.length) await Promise.all(retryRuns)

    // §7.5: every pool prunes by ONE rule — a live connection survives iff its
    // opaque identity is still among the keys consolidation asked for. This
    // replaced five bespoke credential comparisons (appToken+botToken, botToken
    // alone, appId+region+mode, …); a platform now states its identity once, in
    // its key function, and the lifecycle never asks what a key is made of. The
    // Feishu case is the one that used to need spelling out — a region or
    // transport flip must drop the old client so the open loop initializes the
    // correct gateway — and it is now just another key that stopped matching.
    await this.prunePool(this.slackPool, new Set([...direct.values()].map(slackSocketKey)))
    await this.prunePool(this.slackSharedPool, new Set([...shared.values()].map(slackSharedKey)))
    await this.prunePool(this.telegramPool, new Set([...telegram.values()].map(telegramConnKey)))
    await this.prunePool(this.discordPool, new Set([...discord.values()].map(discordConnKey)))
    await this.prunePool(this.feishuPool, new Set([...feishu.values()].map(feishuConnKey)))
  }

  /** Close every connection in `pool` whose opaque identity consolidation no
   *  longer asks for, draining in-flight uses first. Evaluation-owned virtual
   *  connections never enter a pool (they are injected straight into the binding
   *  maps), so they are immune here by construction. */
  private async prunePool<C extends PlatformConnection>(
    pool: ConnectionPool<C>,
    desired: Set<ConnectionKey>
  ): Promise<void> {
    for (const conn of pool.all()) {
      if (desired.has(pool.keyOf(conn))) continue
      await this.host.waitForConnectionUses(conn)
      await conn.stop()
      pool.remove(conn)
    }
  }

  /**
   * Reconcile the connection-derived Slack state (bot identities, integration bindings,
   * open sockets) against the live agent set. Routing itself is rebuilt implicitly each
   * message (mergedRules reads the agents) — this only maintains the socket layer that
   * is otherwise written only at startup.
   *
   * Safe-by-construction (per the recon report):
   *  - NEW appToken  → construct + start an isolated socket, then fan botUserId/conn
   *    out to every integrationId on that appToken. A failed start() is logged and
   *    leaves all existing sockets untouched (never throws out of reconcile).
   *  - NEW integration reusing an ALREADY-OPEN appToken → no socket churn; just
   *    backfill the binding from the existing conn (mention routing for the new bot
   *    would otherwise silently never match).
   *  - REMOVED/re-keyed appToken → closed by closeUnusedPlatformConnections first,
   *    after checking the final roster and captured-turn connection leases.
   */
  async reconcileSlackConnections(): Promise<void> {
    const groups = consolidate(this.host.transportAgents())
    for (const group of groups.values()) {
      const existing = this.slackPool.find(slackSocketKey(group))
      if (existing) {
        // Already-open appToken: bind any integrationId not yet pointing at this conn
        // (tier 1). Covers both a brand-new integrationId AND one that was re-pointed
        // from a different appToken onto this already-open one — without the
        // `!== existing` check the latter would keep its stale mapping/botUserId.
        let bound = false
        for (const { integrationId } of group.integrations) {
          if (this.host.bindings().slack.get(integrationId) !== existing) {
            this.host.bindSlack(integrationId, existing, existing.botUserId)
            this.log.info(`slack: bound integration ${integrationId} onto existing socket (appToken reuse)`)
            bound = true
          }
        }
        // A newly-bound integration needs its channel snapshot reported too.
        if (bound) void this.host.refreshChannels(existing)
        continue
      }
      // New appToken: open an isolated socket (tier 2). Guard so a bad token logs
      // and leaves existing sockets intact instead of throwing out of reconcile.
      try {
        const conn: SlackConnection = new SlackConnection(
          { group, ...this.slackSocketDeps(() => conn) },
          this.host.slackAppFactory()
        )
        this.log.info(
          `slack: opening new socket at runtime (${group.integrations.length} integration(s): ${group.integrations
            .map((i) => i.agentId)
            .join(', ')})…`
        )
        await conn.start()
        this.log.info(`slack: runtime socket connected as bot user ${conn.botUserId}`)
        for (const { integrationId } of group.integrations) this.host.bindSlack(integrationId, conn, conn.botUserId)
        this.slackPool.add(conn)
        void this.host.refreshChannels(conn)
        // This reconcile just brought the socket up; cancel any pending startup-retry
        // timer for the same appToken so it doesn't fire and open a duplicate socket.
        const pending = this.slackRetryTimers.get(group.appToken)
        if (pending !== undefined) {
          this.host.clock().clearTimeout(pending)
          this.slackRetryTimers.delete(group.appToken)
        }
      } catch (err) {
        this.log.error(
          `slack: failed to open runtime socket for appToken — leaving existing sockets intact: ${formatErr(err)}`
        )
      }
    }
    // HTTP-bot send-only clients (wire mode `shared`) — reconciled alongside the sockets.
    await this.openHttpSlackConnections([...this.host.agents().values()])
  }

  /**
   * Open (or reuse) a SEND-ONLY Slack Web-API client per HTTP bot token and bind
   * it, so replies / attachment fetches / MCP platform tools / cron anchors resolve
   * a connection for a `mode:'shared'` integration (shared-bot-relay.md §11). No
   * Socket Mode socket is opened — the bot's inbound arrives from the relay as
   * `rd/msg(im)`. Idempotent: an already-open client for the same xoxb is reused;
   * when a bot flips direct→HTTP transport its old direct socket (same botToken) is
   * stopped so it stops competing with the relay for the single Socket Mode consumer.
   */
  async openHttpSlackConnections(agents: LoadedAgent[]): Promise<void> {
    const groups = consolidateShared(this.host.transportAgents(agents))
    for (const group of groups.values()) {
      let conn = this.slackSharedPool.find(slackSharedKey(group))
      let bound = false
      if (!conn) {
        // `created` (not `conn`) so the shortcut resolver reads this exact connection's bindings.
        const created: SlackConnection = new SlackConnection(
          {
            group,
            sendOnly: true,
            newTraceId: () => randomUUID(),
            onMessage: () => {}, // never called (relay owns inbound)
            // Registered on this transport too: the relay forwards the native Stop, which resolves
            // the conversation's session the same way a Socket Mode stop does.
            onMessageShortcut: (shortcut) =>
              this.host.slackShortcutSession(shortcut, this.host.srcIntegrationIds(created)),
            onStatusAction: (a) => this.host.handleStatusAction(a),
            onStatusInfo: (key) => this.host.statusInfoForKey(key),
            onPermissionChoice: (a) => this.host.handlePermissionChoice(a),
            onElicitChoice: (a) => this.host.handleElicitChoice(a),
            log: this.log
          },
          this.host.slackAppFactory()
        )
        conn = created
        try {
          await conn.start()
          this.slackSharedPool.add(conn)
          this.log.info(`slack: send-only (HTTP) client ready as bot user ${conn.botUserId}`)
        } catch (err) {
          this.log.warn(`slack: HTTP send-only client failed — retry on next reconcile: ${formatErr(err)}`)
          continue
        }
      }
      for (const { integrationId } of group.integrations) {
        if (this.host.bindings().slack.get(integrationId) !== conn) bound = true
        this.host.bindSlack(integrationId, conn, conn.botUserId)
      }
      // HTTP integrations still have the same xoxb Web API surface as direct
      // sockets. Once a send-only client is bound, use it to seed the membership
      // snapshot too; otherwise rows created by shared routing know only the raw
      // channel id and the console can never render Slack's channel name.
      if (bound) void this.host.refreshChannels(conn)
    }
  }

  /**
   * Reconcile the connection-derived Telegram state (bot identities, integration
   * bindings, open long-poll connections) against the live agents. Parallel to
   * reconcileSlackConnections but simpler (Telegram has no app-level token; one
   * connection per bot token):
   *  - NEW bot token → construct + start a long-poll, then bind the bot's @username
   *    (matching what normalize puts in `mentionedBots`) for every integrationId on
   *    that token. A failed start is logged and leaves existing connections intact.
   *  - integration reusing an ALREADY-OPEN token → bind it onto the live conn.
   *  - REMOVED token → closed by closeUnusedPlatformConnections before this opener.
   */
  async reconcileTelegramConnections(): Promise<void> {
    const groups = consolidateTelegram(this.host.transportAgents())
    for (const group of groups.values()) {
      const existing = this.telegramPool.find(telegramConnKey(group))
      if (existing) {
        for (const { integrationId } of group.integrations) {
          if (this.host.bindings().telegram.get(integrationId) !== existing) {
            this.host.bindTelegram(integrationId, existing, existing.botUsername)
            this.log.info(`telegram: bound integration ${integrationId} onto existing bot @${existing.botUsername}`)
          }
        }
        continue
      }
      // Another connect for this token is already in flight (not yet pushed onto
      // telegramConns, so `find()` above can't see it). Skip to avoid opening a duplicate;
      // that connect binds this group's integrations when it resolves.
      if (!this.telegramPool.beginConnect(telegramConnKey(group))) continue
      const conn: TelegramConnection = new TelegramConnection({
        group,
        newTraceId: () => randomUUID(),
        onMessage: (msg) => {
          this.host.channelNameResolver()?.noteMessage(conn, msg)
          this.host.onInbound(msg, this.host.srcIntegrationIds(conn))
        },
        onBotAddedToChat: async (chat) => {
          const integrationIds = new Set(group.integrations.map(({ integrationId }) => integrationId))
          for (const integrationId of this.host.srcIntegrationIds(conn)) integrationIds.add(integrationId)
          await this.host.observeTelegramChat(chat, [...integrationIds])
        },
        onCallback: (cb) => this.host.handleTelegramCallback(cb, conn),
        log: this.log
      })
      try {
        this.log.info(
          `telegram: connecting (${group.integrations.length} integration(s): ${group.integrations
            .map((i) => i.agentId)
            .join(', ')})…`
        )
        await conn.start()
        this.log.info(`telegram: long-poll connected as @${conn.botUsername} (id ${conn.botUserId})`)
        // Mention-routing matches the bot's @username (normalize's mentionedBots are usernames).
        for (const { integrationId } of group.integrations)
          this.host.bindTelegram(integrationId, conn, conn.botUsername)
        this.telegramPool.add(conn)
      } catch (err) {
        await conn.stop().catch(() => {})
        this.log.error(`telegram: failed to open long-poll for a bot token — leaving others intact: ${formatErr(err)}`)
      } finally {
        this.telegramPool.endConnect(telegramConnKey(group))
      }
    }
    // Label existing sessions' chats now that connections are up (per-message resolution
    // otherwise only fires on fresh traffic — see backfillChannelNames).
    await this.backfillChannelNames()
  }

  /**
   * Reconcile the connection-derived Discord state (bot identities, integration
   * bindings, open Gateway connections) against the live agents. Parallel to
   * reconcileTelegramConnections (one Gateway per bot token), but mention-routing
   * matches the bot's numeric user id (normalize's `mentionedBots` are Discord user
   * ids). A failed start is logged and leaves other connections intact (never throws
   * out); removed tokens are closed by the shared close phase.
   */
  async reconcileDiscordConnections(): Promise<void> {
    const groups = consolidateDiscord(this.host.transportAgents())
    for (const group of groups.values()) {
      const existing = this.discordPool.find(discordConnKey(group))
      if (existing) {
        for (const { integrationId } of group.integrations) {
          if (this.host.bindings().discord.get(integrationId) !== existing) {
            this.host.bindDiscord(integrationId, existing, existing.botUserId)
            this.log.info(`discord: bound integration ${integrationId} onto existing bot @${existing.botUsername}`)
          }
        }
        continue
      }
      // Another connect for this token is already in flight (not yet pushed onto
      // discordConns, so `find()` above can't see it). Skip to avoid opening a duplicate;
      // that connect binds this group's integrations when it resolves.
      if (!this.discordPool.beginConnect(discordConnKey(group))) continue
      const conn: DiscordConnection = new DiscordConnection({
        group,
        newTraceId: () => randomUUID(),
        onMessage: (msg) => {
          // Unlike Telegram, Discord CAN resolve an arbitrary user id — collect the
          // sender's (and mentioned users') display names so session read-back labels
          // them by name the way Slack does.
          this.host.channelNameResolver()?.noteMessage(conn, { ...msg, mentionedUserIds: msg.mentionedBots })
          this.host.onInbound(msg, this.host.srcIntegrationIds(conn))
        },
        onStatusAction: (a) => this.host.handleStatusAction(a),
        onSelectAction: (a) => this.host.handleDiscordSelect(a),
        log: this.log
      })
      try {
        this.log.info(
          `discord: connecting (${group.integrations.length} integration(s): ${group.integrations
            .map((i) => i.agentId)
            .join(', ')})…`
        )
        await conn.start()
        this.log.info(`discord: gateway connected as @${conn.botUsername} (id ${conn.botUserId})`)
        // Mention-routing matches the bot's numeric user id (normalize's mentionedBots are ids).
        for (const { integrationId } of group.integrations) this.host.bindDiscord(integrationId, conn, conn.botUserId)
        this.discordPool.add(conn)
      } catch (err) {
        await conn.stop().catch(() => {})
        this.log.error(`discord: failed to open Gateway for a bot token — leaving others intact: ${formatErr(err)}`)
      } finally {
        this.discordPool.endConnect(discordConnKey(group))
      }
    }
    // Label existing sessions' channels now that connections are up (per-message
    // resolution otherwise only fires on fresh traffic — see backfillChannelNames).
    await this.backfillChannelNames()
  }

  /** The live desired gateway region for a Feishu appId, or undefined if no agent
   *  currently has a feishu integration on that appId. Lets an in-flight connect detect a
   *  region change (or removal) that landed during its handshake and self-discard instead
   *  of publishing an old-domain mapping. */
  desiredFeishuConfig(appId: string): { region: FeishuRegion; mode: 'direct' | 'shared' } | undefined {
    for (const group of consolidateFeishu(this.host.transportAgents()).values())
      if (group.appId === appId) return { region: group.region, mode: group.mode }
    return undefined
  }

  /**
   * Reconcile the connection-derived Feishu state (bot identities, integration bindings,
   * provider clients and direct WSClient long-connections) against the live agents.
   * Parallel to reconcileDiscordConnections, but mention-routing matches the bot's own
   * `open_id` (normalize's `mentionedBots` are Feishu open_ids). A failed start is logged
   * and leaves other connections intact (never throws out); a removed appId is NOT torn
   * down here (same deferred-close reasoning as Slack/Telegram/Discord).
   */
  async reconcileFeishuConnections(): Promise<void> {
    const groups = consolidateFeishu(this.host.transportAgents())
    for (const group of groups.values()) {
      // Match on appId AND region: a region change on the same appId must NOT reuse the
      // old-domain client (the prune pass drops it; this guards a same-pass race too).
      const existing = this.feishuPool.find(feishuConnKey(group))
      if (existing) {
        for (const { integrationId } of group.integrations) {
          if (this.host.bindings().feishu.get(integrationId) !== existing) {
            this.host.bindFeishu(integrationId, existing, existing.botOpenId)
            this.log.info(`feishu: bound integration ${integrationId} onto existing app ${existing.appId}`)
          }
        }
        continue
      }
      // A connect for this appId+region is already in flight (not yet pushed onto
      // feishuConns, so `find()` above can't see it). Skip to avoid opening a duplicate;
      // that connect binds this group's integrations when it resolves. Keyed on region
      // too, so a NEW-region reconcile is NOT blocked by an in-flight OLD-region connect.
      const connectKey = feishuConnKey(group)
      if (!this.feishuPool.beginConnect(connectKey)) continue
      const conn: FeishuConnection = new FeishuConnection({
        group,
        newTraceId: () => randomUUID(),
        onMessage: (msg) => {
          this.host.channelNameResolver()?.noteMessage(conn, { ...msg, mentionedUserIds: msg.mentionedBots })
          this.host.onInbound(msg, this.host.srcIntegrationIds(conn))
        },
        onStatusAction: (a) => this.host.handleStatusAction(a),
        log: this.log
      })
      try {
        this.log.info(
          `feishu: connecting (${group.integrations.length} integration(s): ${group.integrations
            .map((i) => i.agentId)
            .join(', ')})…`
        )
        await conn.start()
        // The handshake can take seconds; a region change for this appId may have landed
        // meanwhile. Re-check the live desired region before publishing — otherwise this
        // now-stale (old-domain) connect would bind its mapping over the newer region.
        const desired = this.desiredFeishuConfig(group.appId)
        if (!desired || desired.region !== group.region || desired.mode !== group.mode) {
          await conn.stop().catch(() => {})
          this.log.info(
            `feishu: discarding connect for app ${conn.appId} (${group.region}) — desired region is now ` +
              `${desired ? `${desired.region}/${desired.mode}` : 'none'} (superseded mid-handshake)`
          )
          continue
        }
        this.log.info(
          `feishu: ${conn.mode === 'shared' ? 'send-only HTTP client ready' : 'WSClient connected'} for app ` +
            `${conn.appId} (bot ${conn.botOpenId || '?'})`
        )
        // Mention-routing matches the bot's own open_id (normalize's mentionedBots are open_ids).
        for (const { integrationId } of group.integrations) this.host.bindFeishu(integrationId, conn, conn.botOpenId)
        this.feishuPool.add(conn)
      } catch (err) {
        await conn.stop().catch(() => {})
        this.log.error(`feishu: failed to initialize an appId — leaving others intact: ${formatErr(err)}`)
      } finally {
        this.feishuPool.endConnect(connectKey)
      }
    }
    // Label existing sessions' channels now that connections are up (per-message
    // resolution otherwise only fires on fresh traffic — see backfillChannelNames).
    await this.backfillChannelNames()
  }

  /**
   * Resolve display names for the channels and triggering users of already-stored
   * Discord/Telegram/Feishu sessions so the console labels them without waiting
   * for a new inbound message (the per-message ChannelNameResolver only fires on
   * fresh traffic). The Slack analog is refreshChannels' bulk membership snapshot;
   * these platforms have no cheap channel enumeration, so we resolve each live
   * session's channel individually via its bot connection. Best-effort +
   * TTL-guarded by the resolver, so calling it on every reconcile is cheap.
   */
  async backfillChannelNames(): Promise<void> {
    const resolver = this.host.channelNameResolver()
    if (!resolver) return
    for (const row of await this.host.store().listSessions()) {
      // Only chat platforms without a bulk membership snapshot need per-session
      // channel resolution; Slack's analog is refreshChannels' bulk snapshot.
      if (originKindOf(row.platform) !== 'chat' || manifestFor(row.platform).membershipEnumeration !== 'observed')
        continue
      // Legacy unscoped sessions cannot be attributed to the current physical bot.
      // In particular, never use a replacement bot to look up an old bot's chats.
      if (!row.transportScope) continue
      const integrationId = this.host.integrationIdForTransportScope(row.agentId, row.platform, row.transportScope)
      if (!integrationId) continue
      // The integration id already names its platform's binding — no need to pick
      // a map by platform (§7.5 read side).
      const conn = this.host.connForIntegration(integrationId)
      if (!conn) continue
      if (row.triggeredBy) {
        resolver.noteMessage(conn, {
          channel: row.channel,
          sender: { id: row.triggeredBy, isBot: false }
        })
      } else {
        resolver.noteChannel(conn, row.channel)
      }
    }
    await this.host.refreshObservedChannels()
  }

  /**
   * Withdraw the bot from a conversation (or, on Discord, a whole server) at the
   * PLATFORM, then reconcile the console's channel set.
   *
   * The platforms disagree about what can be left and about what they tell us
   * afterwards, and both differences are load-bearing:
   *
   *  - **Slack** leaves one channel and then EMITS `channel_left`, which re-lists
   *    membership authoritatively and retires the row on its own. Re-listing here
   *    too only makes the console update immediately instead of on the event.
   *  - **Telegram** leaves one chat and tells nobody — no self-event, and its bot
   *    API cannot enumerate chats — so the row survives unless we retract it by id.
   *  - **Discord** has no per-channel membership for a bot at all; leaving means
   *    leaving the guild, which retires every row of that guild at once.
   *
   * Never throws: a platform refusal is the operator's answer, not a daemon fault.
   */
  async leaveConversation(leave: IntegrationLeave): Promise<IntegrationLeaveOk> {
    const integration = this.host.integrationConfigById(leave.integrationId)
    if (!integration) return { ok: false, error: 'integration not found on this daemon' }
    const conn = this.host.connForIntegration(leave.integrationId)
    if (!conn) return { ok: false, error: 'integration is not connected' }
    const { target } = leave
    try {
      if (conn instanceof DiscordConnection) {
        if (target.kind !== 'space') {
          return { ok: false, error: 'Discord bots join servers, not channels — leave the server instead' }
        }
        await conn.leaveSpace(target.spaceId)
        // Every channel of that guild went with it. The snapshot is the only record
        // of which those were: Discord rows are observed, never enumerated.
        const gone = (this.host.channelSnapshots().get(leave.integrationId)?.channels ?? [])
          .filter((c) => c.spaceId === target.spaceId)
          .map((c) => c.id)
        await this.host.retractChannels(leave.integrationId, gone)
        return { ok: true }
      }
      if (target.kind !== 'conversation') {
        return { ok: false, error: 'this platform has no server to leave — leave the channel instead' }
      }
      if (conn instanceof SlackConnection) {
        await conn.leaveChannel(target.channel)
        // Authoritative re-list; also arrives via channel_left, and both converge.
        await this.host.refreshChannels(conn)
        return { ok: true }
      }
      if (conn instanceof TelegramConnection) {
        try {
          await conn.leaveChannel(target.channel)
        } catch (err) {
          // Already out — someone removed the bot in Telegram and the row simply
          // outlived it, which is the whole reason these rows accumulate. Leaving is
          // the ONLY action offered on a Telegram row, so it has to finish the job in
          // both states: refusing here would strand the operator with a row they can
          // see, cannot leave, and have no other control over. Any other failure is
          // still reported. Worst case of a mis-read error is the documented
          // behaviour of a removed row — it returns on the conversation's next message.
          if (!isAlreadyOutOfChat(err)) throw err
          this.log.debug(`telegram: already out of ${target.channel} — retracting the row`)
        }
        await this.host.retractChannels(leave.integrationId, [target.channel])
        return { ok: true }
      }
      return { ok: false, error: 'leaving a conversation is not supported on this platform' }
    } catch (err) {
      // The platform's own words — a missing scope, `last_member`, a lost right.
      const error = (err as Error).message
      this.log.warn(`integration/leave failed (${integration.platform}): ${error}`)
      return { ok: false, error }
    }
  }

  /**
   * Re-list the channels this connection's bot is a member of and report the
   * snapshot to the CP for every integration bound to the connection (one bot ⇒
   * one membership set, fanned out per integrationId). Best-effort + never throws:
   * a Slack API failure keeps the previous snapshot (listBotChannels returns null),
   * and the emit is a no-op while the CP is down — the cached snapshot is re-emitted
   * on the next CP (re)connect (see startCpClient's onReady).
   */
  async refreshChannels(conn: SlackConnection): Promise<void> {
    try {
      const channels = await conn.listBotChannels()
      if (!channels) return
      // The snapshot already carries names — cache them for session read-back too.
      for (const c of channels) {
        if (!c.name) continue
        await this.host.store().setDisplayName(c.id, c.name, Date.now())
        await this.host.emitSessionMetadataSnapshotsForDisplayName(c.id)
      }
      const snapshots = this.host.channelSnapshots()
      for (const [integrationId, c] of this.host.bindings().slack) {
        if (c !== conn) continue
        // Preserve observed direct rows: the membership listing carries channels
        // only, while 1:1 and group DMs arrive incrementally. A refresh must not wipe
        // them from the reconnect snapshot.
        const direct = (snapshots.get(integrationId)?.channels ?? []).filter(
          (x) => x.kind === 'im' || x.kind === 'mpim'
        )
        const merged = [...channels, ...direct]
        snapshots.set(integrationId, { channels: merged, authoritative: true })
        this.host.cpClient()?.emitIntegrationChannels({ integrationId, channels: merged })
        await this.maybeIntroduceOnJoin('slack', integrationId, channels)
      }
      this.log.debug(`slack: channel snapshot for bot ${conn.botUserId}: ${channels.length} channel(s)`)
    } catch (err) {
      this.log.debug(`slack: channel snapshot refresh failed: ${formatErr(err)}`)
    }
  }

  /**
   * Self-introduce-on-join (issue #536). Given one integration's fresh channel
   * snapshot, detect GENUINE new joins against durable state and, for an opted-in
   * agent, dispatch a one-shot headless intro turn per newly-joined channel — the
   * agent introduces itself to the peers already there via `messageAgent`.
   *
   * Storm-safe: the FIRST snapshot per integration (and any batch larger than
   * `INTRO_MAX_BURST`) is adopted as the silent baseline, so a daemon restart /
   * socket reconnect that re-lists every channel never fires intros. State is
   * marked BEFORE dispatch, so a failed turn is simply skipped (never retried in a
   * loop). Not opted in ⇒ no seeding either, so enabling it later baselines cleanly.
   */
  async maybeIntroduceOnJoin(platform: string, integrationId: string, channels: { id: string }[]): Promise<void> {
    const agent = [...this.host.agents().values()].find((a) => a.integrations.some((i) => i.id === integrationId))
    if (!agent?.introduceOnJoin) return
    const store = this.host.store()
    const plan = planChannelIntros(
      {
        seeded: await store.isChannelIntroSeeded(integrationId),
        introduced: await store.channelIntroSet(agent.id, platform)
      },
      channels.map((c) => c.id)
    )
    const now = this.host.clock().now()
    for (const ch of plan.adoptSilently) await store.markChannelIntro(agent.id, platform, ch, null)
    if (plan.markSeeded) await store.markChannelIntroSeeded(integrationId, now)
    for (const ch of plan.introduce) {
      await store.markChannelIntro(agent.id, platform, ch, now)
      this.log.info(`intro: agent "${agent.id}" self-introducing in channel ${ch}`)
      const traceId = randomUUID()
      const msg = buildIntroMessage(agent.id, platform, ch, traceId)
      // `deliverHeadless` marks THIS turn's fan-out: peers woken via messageAgent run
      // headless and record the newcomer silently. No correlationId ⇒ no orchestration /
      // worker-report side effect (recordWorkerReport only fires on a correlationId).
      // No origin fields (§5.3): a self-introduce is root-like — the woken peer has no parent
      // session to reply into, so it gets no `Parent session` line and no SessionTarget.
      // `introChannel` is the CODE-level bound on the fan-out: discovery in this turn is
      // pinned to the joined channel whatever the model passes to `listAgents` (the prompt
      // asks for the same filter, but a prompt is not a bound — see CallMeta.introChannel).
      const callMeta: CallMeta = {
        callFrom: agent.id,
        hopCount: 0,
        deliveryId: traceId,
        deliverHeadless: true,
        introChannel: ch
      }
      void this.host
        .dispatch(agent.id, msg, integrationId, callMeta)
        .catch((err) => this.log.warn(`intro: dispatch failed for agent "${agent.id}" in ${ch}: ${formatErr(err)}`))
    }
  }

  /**
   * Background retry loop for a Slack connection that failed at initial startup.
   * Creates a fresh SlackConnection (the old one is in an unknown state) and, on
   * success, wires it into the bindings and the pool so the agent can begin
   * processing messages. On failure, schedules another retry at a slow, fixed
   * interval — never gives up, so a temporary network outage self-heals without
   * manual daemon restart.
   */
  startSlackRetry(appToken: string): void {
    if (this.slackRetryRuns.has(appToken)) return
    const group = consolidate(this.host.transportAgents()).get(appToken)
    if (!group) return
    const run = this.retrySlackConnection(appToken)
      .catch((err) => this.log.error(`slack: retry loop error: ${formatErr(err)}`))
      .finally(() => {
        if (this.slackRetryRuns.get(appToken)?.promise === run) this.slackRetryRuns.delete(appToken)
      })
    this.slackRetryRuns.set(appToken, { botToken: group.botToken, promise: run })
  }

  private async retrySlackConnection(appToken: string): Promise<void> {
    if (this.host.draining()) return
    // Never reuse a captured integration roster: an agent may have detached (or a
    // token may have moved) during the 60s backoff. Resolve the current group now.
    const group = consolidate(this.host.transportAgents()).get(appToken)
    if (!group) {
      this.slackRetryTimers.delete(appToken)
      return
    }
    // A file-watch reconcile (reconcileSlackConnections) may have opened this
    // appToken's socket while the retry timer was pending. Opening another here would
    // leave two live Socket Mode connections for one app (a wasted per-app connection
    // slot). The live socket is authoritative — drop the timer and bail.
    if (this.slackPool.find(slackSocketKey(group)) !== undefined) {
      this.slackRetryTimers.delete(group.appToken)
      return
    }
    this.log.info(
      `slack: background retry for appToken (${group.integrations.length} integration(s): ${group.integrations.map((i) => i.agentId).join(', ')})…`
    )
    // The thunk captures the NEW `conn` ref so the name resolver / onInbound use the
    // successfully-retried connection, not a stale one from an earlier attempt.
    const conn: SlackConnection = new SlackConnection(
      { group, ...this.slackSocketDeps(() => conn) },
      this.host.slackAppFactory()
    )
    try {
      await conn.start()
      // The roster may have changed while start() was in flight. Never publish a
      // socket or captured integration list from before a detach/token handoff.
      const currentGroup = consolidate(this.host.transportAgents()).get(appToken)
      if (this.host.draining() || !currentGroup || currentGroup.botToken !== group.botToken) {
        await conn.stop().catch(() => {})
        this.slackRetryTimers.delete(appToken)
        return
      }
      this.log.info(`slack: background retry succeeded — connected as bot user ${conn.botUserId}`)
      this.slackRetryTimers.delete(group.appToken)
      for (const { integrationId } of currentGroup.integrations)
        this.host.bindSlack(integrationId, conn, conn.botUserId)
      this.slackPool.add(conn)
      void this.host.refreshChannels(conn)
    } catch (err) {
      // Release the half-open connection before discarding it so a failure during
      // app.start() doesn't leak a live reconnecting Bolt client each iteration.
      await conn.stop().catch(() => {})
      if (this.host.draining() || !consolidate(this.host.transportAgents()).has(appToken)) {
        this.slackRetryTimers.delete(appToken)
        return
      }
      this.log.warn(`slack: background retry failed — scheduling next attempt in 60s: ${formatErr(err)}`)
      const timer = this.host.clock().setTimeout(() => {
        if (this.host.draining()) return
        this.startSlackRetry(appToken)
      }, 60_000)
      this.slackRetryTimers.set(group.appToken, timer)
    }
  }

  /** Cancel every pending startup-retry timer. Called early in daemon stop, before
   *  the turn drain, so no new socket can be opened while shutdown proceeds. */
  cancelRetryTimers(): void {
    for (const t of this.slackRetryTimers.values()) this.host.clock().clearTimeout(t)
    this.slackRetryTimers.clear()
  }

  /** Join any retry attempt still inside `conn.start()`, then stop every pooled
   *  connection. Called late in daemon stop, once every turn has settled; failures
   *  are collected rather than thrown so one bad client cannot abort teardown. */
  async dispose(): Promise<unknown[]> {
    const errors: unknown[] = []
    for (const run of [...this.slackRetryRuns.values()]) await Promise.resolve(run.promise).catch((e) => errors.push(e))
    for (const pool of this.pools())
      for (const c of pool.all()) await Promise.resolve(c.stop()).catch((e) => errors.push(e))
    return errors
  }
}
