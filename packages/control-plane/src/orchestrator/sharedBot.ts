/**
 * `SharedBotOrchestrator` (shared-bot-relay.md §4.2 / §5 / §10) — the CP side of
 * shared bots: it places each shareable bot's INBOUND onto exactly one relay,
 * compiles the ATTRIBUTED routing table (channel ownership → keyword → default
 * agent), pushes it via `rc/bot-assign` / `rc/routes`, and delivers the SHARED
 * (send-only) integration spec to each member agent's daemon.
 *
 * It is the convergence seam invoked on every event that can change a shared
 * bot's placement or routes: an install / uninstall, the shareable toggle, a
 * per-channel default-agent change, and — for failover — a relay (re)register or
 * sweep. Every method is idempotent: it recomputes from the DB and pushes the
 * result, so a missed push self-heals on the next call.
 *
 * "CP never sees message content" is preserved: this only ever ships credentials
 * + routing tables to relays and send-only specs to daemons — never a message.
 * Secret material (`secrets`, tokens) MUST NEVER be logged.
 */
import type {
  AttributedRoute,
  RcBotAssign,
  BindMatch,
  RcThreadAssign,
  RcThreadLookup,
  RcThreadLookupOk
} from '@agentconnect.md/protocol'
import type {
  BotRepo,
  BotRecord,
  BotSecretStore,
  BotSecretMaterial,
  IntegrationRepo,
  IntegrationRecord,
  IntegrationChannelRepo,
  IntegrationChannelRecord,
  ChannelTrigger,
  ReportedChannel,
  AgentRepo,
  AgentRecord,
  ThreadAffinityStore,
  SessionRepo
} from '../persistence/ports.js'
import type { RelayChannel, RelayRegistry } from '../ws/relay-registry.js'
import { ControlSender, NoConnection } from './outbound.js'
import { isGatedAgent, sharedIntegrationToSpec } from './placement.js'
import { AgentId, BotId, DaemonId } from '../domain/ids.js'

export interface SharedBotLog {
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  debug?(obj: unknown, msg?: string): void
}

/** The compiled routing table for one shared bot (relay-agnostic). */
interface Compiled {
  platform: 'slack' | 'telegram' | 'discord'
  members: { daemonId: string; agentIds: string[] }[]
  /** Member directory (id→name→daemon) for the relay's config-modal selector. */
  agents: { agentId: string; name: string; daemonId: string }[]
  routes: AttributedRoute[]
  defaultAgentId?: string
  defaultDaemonId?: string
  /** Members whose ingress is conversation-gated (resource-visibility.md §14). */
  gatedAgentIds: string[]
  /** DM conversation ids whose §14.3 notice was ACTUALLY DELIVERED — the
   *  pool-wide latch for single-copy DM messages (never row-derived: discovery
   *  without delivery must not latch). */
  noticedDmConversations: string[]
  /** Placed member integrations (spec push targets: daemonId + integration). */
  placed: { integration: IntegrationRecord; daemonId: string; gated: boolean }[]
}

/** Resolve a persisted owner marker to its active integration, falling back to
 * the earliest active install for new or legacy ownerless channels. */
export function pickChannelOwner(
  installs: IntegrationRecord[],
  rows: IntegrationChannelRecord[]
): IntegrationRecord | undefined {
  const assigned = new Set(rows.flatMap((row) => (row.agentId ? [row.agentId] : [])))
  return installs.find((integration) => assigned.has(integration.agentId)) ?? installs[0]
}

export class SharedBotOrchestrator {
  private readonly channelMutationChains = new Map<string, Promise<unknown>>()

  constructor(
    private readonly bots: BotRepo,
    private readonly botSecret: BotSecretStore,
    private readonly integrations: IntegrationRepo,
    private readonly channels: IntegrationChannelRepo,
    private readonly agents: AgentRepo,
    private readonly relayReg: RelayRegistry,
    private readonly control: ControlSender,
    private readonly threads: ThreadAffinityStore,
    private readonly sessions: SessionRepo,
    private readonly log: SharedBotLog
  ) {}

  /**
   * Converge one bot: BROADCAST `rc/bot-assign` to every connected relay (whole-pool
   * ingress — any pod may receive an inbound Events API POST via the stable
   * PUBLIC_RELAY_URL LB) + deliver the shared spec to each member daemon. A
   * non-http / empty bot is released. Safe to call for a socket bot (no-op after
   * the release check).
   */
  async syncBot(botId: string): Promise<void> {
    const bot = await this.bots.get(BotId(botId))
    if (!bot) return
    if (bot.transport !== 'http' || bot.agentIds.length === 0) {
      await this.unassign(bot)
      return
    }
    const compiled = await this.compile(bot)
    if (!compiled) {
      await this.unassign(bot)
      return
    }
    const secret = await this.botSecret.get(bot.id)
    if (!secret) {
      this.log.warn({ botId }, 'shared-bot: no secret for http bot — cannot assign')
      return
    }
    if (bot.platform === 'slack' && !secret.signingSecret) {
      // An http-mode Slack bot with no signing secret can't be verified by the relay.
      this.log.warn({ botId }, 'shared-bot: no signing secret for http Slack bot — cannot assign')
      return
    }

    if (this.relayReg.all().length === 0) {
      // No connected relay to host the ingest — the register replay re-fans when one
      // (re)connects (reconcileAll / replayTo).
      this.log.warn({ botId }, 'shared-bot: no connected relay available — deferring placement')
      return
    }

    const assign = this.buildAssign(bot, compiled, secret)
    this.broadcast((ch) => ch.send('rc/bot-assign', assign))
    this.log.info(
      { botId: bot.id, members: compiled.members.length, routes: compiled.routes.length },
      'shared-bot: broadcast assign to relay pool'
    )
    await this.pushSpecs(compiled, secret, bot)
  }

  /**
   * A routes-only change (a per-channel default agent, a trigger flip) on an
   * already-placed bot: hot-update the relay's table via `rc/routes` (no ingest
   * re-open). Falls back to a full `syncBot` if the bot isn't placed on a
   * connected relay yet.
   */
  async syncRoutes(botId: string): Promise<void> {
    const bot = await this.bots.get(BotId(botId))
    if (!bot || bot.transport !== 'http' || bot.agentIds.length === 0) return this.syncBot(botId)
    if (this.relayReg.all().length === 0) return this.syncBot(botId) // nobody connected → defer
    const compiled = await this.compile(bot)
    if (!compiled) return this.unassign(bot)
    this.broadcast((ch) =>
      ch.send('rc/routes', {
        botId: bot.id,
        members: compiled.members,
        agents: compiled.agents,
        routes: compiled.routes,
        ...(compiled.defaultAgentId ? { defaultAgentId: compiled.defaultAgentId } : {}),
        ...(compiled.defaultDaemonId ? { defaultDaemonId: compiled.defaultDaemonId } : {}),
        gatedAgentIds: compiled.gatedAgentIds,
        noticedDmConversations: compiled.noticedDmConversations,
        ...(this.noticeAuthorityFor(bot.id) ? { noticeAuthority: this.noticeAuthorityFor(bot.id) } : {})
      })
    )
    const secret = await this.botSecret.get(bot.id)
    if (secret) await this.pushSpecs(compiled, secret, bot)
  }

  /** Release a bot from the relay pool (transport flipped / uninstalled / last
   *  install removed): broadcast `rc/bot-unassign` to every connected relay. */
  async unassign(bot: BotRecord): Promise<void> {
    this.broadcast((ch) => ch.send('rc/bot-unassign', { botId: bot.id }))
  }

  /** Converge EVERY http+active bot — the failover / broad-change worklist. */
  async reconcileAll(): Promise<void> {
    const http = await this.bots.listHttpActive()
    for (const b of http) await this.syncBot(b.id)
  }

  /**
   * Per-relay register replay (whole-pool seed): send `rc/bot-assign` for every
   * http bot with ≥1 active install, plus each persisted thread binding, to ONLY the
   * freshly-registered relay `ch` (no re-broadcast to the whole pool). Sibling of
   * `HookService.replayTo`.
   *
   * KNOWN (low-severity, self-healing): this reads a `listForBot` snapshot and a
   * concurrent live `rc/assign` broadcast to the same just-registered relay could
   * interleave, transiently leaving it one version behind for a thread whose owner
   * changed mid-replay. It re-converges on that thread's next report / this relay's
   * next reconnect; not worth a per-binding version on the wire.
   */
  async replayTo(ch: RelayChannel): Promise<void> {
    const bots = await this.bots.listHttpActive()
    for (const bot of bots) {
      const compiled = await this.compile(bot)
      if (!compiled) continue
      const secret = await this.botSecret.get(bot.id)
      if (!secret) continue
      if (bot.platform === 'slack' && !secret.signingSecret) continue
      try {
        ch.send('rc/bot-assign', this.buildAssign(bot, compiled, secret))
        for (const t of await this.threads.listForBot(bot.id)) {
          ch.send('rc/assign', { botId: bot.id, sessionKey: t.sessionKey, agentId: t.agentId, daemonId: t.daemonId })
        }
      } catch {
        // dead socket — its onClose removes it from the registry
      }
    }
  }

  /**
   * Durable thread-affinity REPORT leg (§10 step 3): persist the (botId, sessionKey)
   * → {agentId, daemonId} binding a relay just reported (rc/thread-assign) and
   * BROADCAST it back to every relay (rc/assign) so any pool pod routes the same
   * thread to the same agent. The CP is the single writer.
   */
  async recordThreadAssign(m: RcThreadAssign): Promise<void> {
    await this.threads.upsert(BotId(m.botId), m.sessionKey, AgentId(m.agentId), DaemonId(m.daemonId))
    this.broadcast((ch) =>
      ch.send('rc/assign', { botId: m.botId, sessionKey: m.sessionKey, agentId: m.agentId, daemonId: m.daemonId })
    )
  }

  /** Pull-on-miss BACKSTOP leg (§10): answer a relay's `rc/thread-lookup` from the
   *  persisted binding (`target: null` ⇒ the CP holds none). A binding to a GATED
   *  agent is honoured only while its conversation is still enabled (§14) — a
   *  thread bound before the gate was applied must not keep re-seeding relay
   *  affinity forever. */
  async lookupThread(m: RcThreadLookup): Promise<RcThreadLookupOk> {
    const channel = m.sessionKey.slice(0, Math.max(m.sessionKey.indexOf('/'), 0)) || m.sessionKey
    const t = await this.threads.get(BotId(m.botId), m.sessionKey)
    if (t) {
      if (!(await this.threadTargetAllowed(m.botId, channel, t.agentId))) {
        return { botId: m.botId, sessionKey: m.sessionKey, target: null }
      }
      return { botId: m.botId, sessionKey: m.sessionKey, target: { agentId: t.agentId, daemonId: t.daemonId } }
    }
    // Affinity miss: fall back to session metadata. A session an agent created directly on the
    // daemon (e.g. its own channel-root post, session-concept §7.2 case 2a) never went through
    // the relay's mention/switch REPORT leg, so no `thread-assign` seeded the affinity store —
    // but the daemon reported the session's (channel, thread, agentId, daemonId). Resolve it so an
    // un-mentioned follow-up in that thread still routes to the owning agent instead of dropping.
    // sessionKey is `channel/thread` (relay `sessionKeyOf`); split on the FIRST '/'.
    const slash = m.sessionKey.indexOf('/')
    if (slash > 0) {
      const channel = m.sessionKey.slice(0, slash)
      const thread = m.sessionKey.slice(slash + 1)
      const owner = await this.sessions.findThreadOwner(BotId(m.botId), channel, thread)
      if (owner && (await this.threadTargetAllowed(m.botId, channel, owner.agentId))) {
        return { botId: m.botId, sessionKey: m.sessionKey, target: owner }
      }
    }
    return { botId: m.botId, sessionKey: m.sessionKey, target: null }
  }

  /** §14 conversation-gating check for the thread-lookup backstop: a non-gated
   *  target is always allowed; a gated target needs its install's row for this
   *  conversation to be enabled (trigger ≠ off). Fail-closed on missing rows. */
  private async threadTargetAllowed(botId: string, channel: string, agentId: string): Promise<boolean> {
    const agent = await this.agents.get(AgentId(agentId))
    if (!agent) return false
    if (!isGatedAgent(agent)) return true
    const installs = await this.integrations.listForBot(BotId(botId))
    const install = installs.find((i) => i.agentId === agentId)
    if (!install) return false
    const rows = await this.channels.listForBot(BotId(botId))
    const row = rows.find((c) => c.integrationId === install.id && c.channelId === channel)
    return !!row && row.trigger !== 'off'
  }

  /** Is at least one relay connected right now? The install-time gate: a shared
   *  install with no relay to host the ingest is a deployment misconfig (§6 409). */
  hasConnectedRelay(): boolean {
    return this.relayReg.all().length > 0
  }

  /** Apply the authoritative channel-membership snapshot reported by the Slack
   *  HTTP ingest. Every active integration of the bot represents the same Slack
   *  app membership, so fan the snapshot across them, preserving per-install
   *  trigger/owner fields in the repository, then hot-refresh relay routes.
   *
   *  For a shared bot, route compilation converges every reported channel to
   *  exactly one owner. A new or ownerless channel is assigned to the bot's
   *  creating (earliest active) agent, while an existing owner is preserved.
   */
  async replaceChannels(botId: string, channels: ReportedChannel[]): Promise<void> {
    const bot = await this.bots.get(BotId(botId))
    if (!bot || bot.platform !== 'slack' || bot.transport !== 'http') {
      this.log.warn({ botId }, 'shared-bot: channel snapshot for a non-http/unknown Slack bot — ignored')
      return
    }
    const installs = await this.integrations.listForBot(bot.id)
    for (const integration of installs) {
      // Conversation gating (§14): a gated install's fresh channels start Off — an
      // editor must enable them in the console before the compiler emits a route.
      const owner = await this.agents.get(integration.agentId)
      const defaultTrigger = owner && isGatedAgent(owner) ? ('off' as const) : undefined
      await this.channels.replaceSnapshot(integration.id, channels, defaultTrigger ? { defaultTrigger } : undefined)
    }
    await this.syncRoutes(botId)
  }

  /** §14.3 DM notices ACTUALLY DELIVERED (`botId:channel`), reported via
   *  `rc/notice-posted`. Per CP lifetime (a restart allows one fresh notice —
   *  the daemon's own latch semantics); size-bounded. */
  private readonly noticedDms = new Set<string>()

  /** Record one delivered §14.3 DM notice and re-stamp the pool so every pod
   *  latches the conversation. Fire-and-forget from the relay's perspective. */
  async recordNoticePosted(m: { botId: string; channel: string }): Promise<void> {
    const key = `${m.botId}:${m.channel}`
    if (this.noticedDms.has(key)) return
    if (this.noticedDms.size >= 100_000) this.noticedDms.clear()
    this.noticedDms.add(key)
    await this.syncRoutes(m.botId)
  }

  /** §14.3: the relay DETERMINISTICALLY responsible for a bot's one-time gating
   *  notices, chosen from the CONNECTED roster at (re)assign/replay time — pure
   *  config-time orchestration, never a per-message CP round-trip (the CP stays
   *  off the message hot path). Stable while the roster is stable; a roster
   *  change re-broadcasts and moves the authority (its local latch moves too —
   *  per-lifetime notice semantics, matching the daemon). Undefined ⇒ no relay. */
  private noticeAuthorityFor(botId: string): string | undefined {
    const ids = this.relayReg
      .all()
      .map((ch) => ch.relayId)
      .sort()
    if (ids.length === 0) return undefined
    let h = 0
    for (const c of botId) h = (h * 31 + c.charCodeAt(0)) >>> 0
    return ids[h % ids.length]
  }

  /**
   * §14.3: fan an INCREMENTAL DM-conversation report across the bot's GATED installs
   * as `kind:'im'` rows (default Off, owned by each install's agent) so console
   * editors can enable the DM. Non-gated installs are untouched — their DMs already
   * route via `defaultAgentId`. Idempotent, and no route recompile: an Off row
   * compiles nothing; the recompile happens when an editor enables it.
   */
  async reportConversation(botId: string, conversation: ReportedChannel): Promise<void> {
    const bot = await this.bots.get(BotId(botId))
    if (!bot || bot.platform !== 'slack' || bot.transport !== 'http') {
      this.log.warn({ botId }, 'shared-bot: conversation report for a non-http/unknown Slack bot — ignored')
      return
    }
    const installs = await this.integrations.listForBot(bot.id)
    for (const install of installs) {
      const agent = await this.agents.get(install.agentId)
      if (!agent || !isGatedAgent(agent)) continue
      await this.channels.upsertConversation(
        install.id,
        { ...conversation, kind: 'im' },
        { agentId: AgentId(install.agentId), defaultTrigger: 'off' }
      )
    }
    // No route recompile: an Off row compiles nothing, and the notice latch is
    // deliberately NOT row-derived (rc/notice-posted owns it) — a conversation
    // discovered while a public default still routed it must keep its claim to a
    // notice if it later becomes unroutable.
  }

  /**
   * Update a shared channel through its bot-level ownership boundary. The selected
   * agent becomes the sole owner, and the channel trigger follows the channel when
   * ownership changes instead of reverting to a stale per-install value.
   */
  async updateChannel(
    botId: string,
    channelId: string,
    patch: { agentId?: string; trigger?: ChannelTrigger },
    options: { expectedOwnerAgentId?: string; source?: 'console' | 'slack' } = {}
  ): Promise<IntegrationChannelRecord | null> {
    return this.serializeChannelMutation(botId, channelId, async () => {
      const bot = await this.bots.get(BotId(botId))
      if (bot?.transport !== 'http') {
        this.log.warn({ botId }, 'shared-bot: update-channel for a non-http/unknown bot — ignored')
        return null
      }
      const installs = await this.integrations.listForBot(bot.id)
      if (installs.length === 0) return null
      const rows = (await this.channels.listForBot(bot.id)).filter(
        (row) => row.kind === 'channel' && row.channelId === channelId
      )
      const currentOwner = pickChannelOwner(installs, rows)
      if (options.expectedOwnerAgentId && currentOwner?.agentId !== options.expectedOwnerAgentId) {
        this.log.warn(
          { botId, channelId, expectedOwnerAgentId: options.expectedOwnerAgentId },
          'shared-bot: channel owner changed before update — ignored'
        )
        return null
      }
      const owner = patch.agentId ? installs.find((i) => i.agentId === patch.agentId) : currentOwner
      if (!owner) {
        this.log.warn({ botId, agentId: patch.agentId }, 'shared-bot: update-channel for a non-member agent — ignored')
        return null
      }

      const currentRow = currentOwner
        ? (rows.find((row) => row.agentId === currentOwner.agentId) ??
          rows.find((row) => row.integrationId === currentOwner.id))
        : undefined
      const targetAgent = options.source === 'slack' ? await this.agents.get(owner.agentId) : null
      let updated = await this.persistChannelOwner(installs, channelId, owner)
      const trigger =
        targetAgent && isGatedAgent(targetAgent)
          ? ('off' as const)
          : (patch.trigger ?? currentRow?.trigger ?? rows[0]?.trigger ?? updated.trigger)
      await this.syncChannelTrigger(installs, channelId, trigger, rows)
      updated = { ...updated, trigger }
      await this.syncRoutes(botId)
      return updated
    })
  }

  /** The in-Slack config modal changes only the owner. A workspace user must
   * never enable a restricted agent, so that target always starts Off. */
  async setChannelAgent(botId: string, channelId: string, agentId: string): Promise<void> {
    await this.updateChannel(botId, channelId, { agentId }, { source: 'slack' })
  }

  /** Preserve bot-scoped channel state before an owner integration is deleted. */
  async prepareIntegrationRemoval(botId: string): Promise<void> {
    const bot = await this.bots.get(BotId(botId))
    if (bot?.transport !== 'http') return
    const installs = await this.integrations.listForBot(bot.id)
    await this.ensureChannelOwners(bot.id, installs)
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Serialize the owner check and write per channel. Console authorization
   * happens before this boundary and supplies the owner it authorized; a queued
   * Slack move therefore makes that Console mutation fail closed. */
  private serializeChannelMutation<T>(botId: string, channelId: string, run: () => Promise<T>): Promise<T> {
    const key = `${botId}\u0000${channelId}`
    const previous = this.channelMutationChains.get(key) ?? Promise.resolve()
    const result = previous.then(run, run)
    const settled = result.then(
      () => undefined,
      () => undefined
    )
    this.channelMutationChains.set(key, settled)
    void settled.finally(() => {
      if (this.channelMutationChains.get(key) === settled) this.channelMutationChains.delete(key)
    })
    return result
  }

  /** Store one canonical owner row and clear every sibling install's copy. */
  private async persistChannelOwner(
    installs: IntegrationRecord[],
    channelId: string,
    owner: IntegrationRecord
  ): Promise<IntegrationChannelRecord> {
    const ownerAgent = await this.agents.get(owner.agentId)
    const defaultTrigger = ownerAgent && isGatedAgent(ownerAgent) ? ('off' as const) : undefined
    const updated = await this.channels.upsertAgent(
      owner.id,
      channelId,
      owner.agentId,
      defaultTrigger ? { defaultTrigger } : undefined
    )
    // Establish the replacement before clearing stale markers: even if a later
    // cleanup write fails, the channel never regresses to having no owner.
    for (const integration of installs) {
      if (integration.id === owner.id) continue
      await this.channels.setAgent(integration.id, channelId, null)
    }
    return updated
  }

  /** Keep the effective trigger on every active membership row, creating a
   * missing sibling from the best available channel metadata. Ownership is
   * canonical, but complete repeated state lets owner deletion preserve the
   * channel and trigger even before a new install reports its own snapshot. */
  private async syncChannelTrigger(
    installs: IntegrationRecord[],
    channelId: string,
    trigger: ChannelTrigger,
    knownRows: IntegrationChannelRecord[]
  ): Promise<void> {
    const known = new Map(knownRows.map((row) => [row.integrationId, row]))
    const template = knownRows.find((row) => row.name !== null) ?? knownRows[0]
    for (const integration of installs) {
      const row = known.get(integration.id)
      if (row?.trigger === trigger) continue
      if (!row) {
        const backfilled = await this.channels.upsertConversation(
          integration.id,
          {
            id: channelId,
            ...(template?.name ? { name: template.name } : {}),
            isPrivate: template?.isPrivate ?? false,
            kind: 'channel'
          },
          { defaultTrigger: trigger }
        )
        if (backfilled.trigger === trigger) continue
      }
      await this.channels.setTrigger(integration.id, channelId, trigger)
    }
  }

  /**
   * Converge every channel to one canonical owner. This repairs owner deletion,
   * legacy ownerless rows, and older Web writes that stored an owner on the wrong
   * integration. DM rows are intentionally excluded because gated DMs may enable
   * several agents independently.
   */
  private async ensureChannelOwners(botId: BotId, installs: IntegrationRecord[]): Promise<void> {
    if (installs.length === 0) return
    const rows = (await this.channels.listForBot(botId)).filter((row) => row.kind === 'channel')
    const channelIds = [...new Set(rows.map((row) => row.channelId))]
    for (const channelId of channelIds) {
      const channelRows = rows.filter((row) => row.channelId === channelId)
      const owner = pickChannelOwner(installs, channelRows)
      if (!owner) continue
      const persistedOwner = channelRows.some((row) => row.agentId === owner.agentId)
      let trigger =
        channelRows.find((row) => row.agentId === owner.agentId)?.trigger ??
        channelRows.find((row) => row.integrationId === owner.id)?.trigger ??
        channelRows[0]?.trigger
      if (!persistedOwner) {
        const ownerAgent = await this.agents.get(owner.agentId)
        if (ownerAgent && isGatedAgent(ownerAgent)) trigger = 'off'
      }
      const canonical = channelRows.some((row) => row.integrationId === owner.id && row.agentId === owner.agentId)
      const conflicting = channelRows.some(
        (row) => row.agentId !== null && (row.integrationId !== owner.id || row.agentId !== owner.agentId)
      )
      if (!canonical || conflicting) await this.persistChannelOwner(installs, channelId, owner)
      if (trigger !== undefined) await this.syncChannelTrigger(installs, channelId, trigger, channelRows)
    }
  }

  /** Compile the attributed routing table after converging channel ownership. */
  private async compile(bot: BotRecord): Promise<Compiled | null> {
    const integrations = await this.integrations.listForBot(bot.id)
    if (integrations.length === 0) return null
    await this.ensureChannelOwners(bot.id, integrations)
    const agentById = new Map<string, AgentRecord>()
    for (const i of integrations) {
      const a = await this.agents.get(i.agentId)
      if (a) agentById.set(i.agentId, a)
    }
    // Only agents currently PLACED on a daemon can receive traffic.
    const placed = integrations
      .map((integration) => ({ integration, agent: agentById.get(integration.agentId) }))
      .filter((x): x is { integration: IntegrationRecord; agent: AgentRecord } => !!x.agent?.daemonId)
      .map((x) => ({
        integration: x.integration,
        agent: x.agent,
        daemonId: x.agent.daemonId!,
        gated: isGatedAgent(x.agent)
      }))
    if (placed.length === 0) return null

    // members: daemonId → agentIds (the daemon connections the relay expects).
    const memberMap = new Map<string, Set<string>>()
    for (const p of placed) {
      const set = memberMap.get(p.daemonId) ?? new Set<string>()
      set.add(p.integration.agentId)
      memberMap.set(p.daemonId, set)
    }
    const members = [...memberMap].map(([daemonId, ids]) => ({ daemonId, agentIds: [...ids] }))

    const byAgent = new Map(placed.map((p) => [p.integration.agentId, p]))
    const routes: AttributedRoute[] = []

    // 1. channel ownership (§10.1, the primary path): a channel with a default agent
    //    routes to that agent, respecting the channel's trigger (any → auto rule,
    //    mention → mention rule). Emitted FIRST so a scoped rule wins arbitration.
    const chans = await this.channels.listForBot(bot.id)
    for (const c of chans) {
      if (!c.agentId) continue
      const p = byAgent.get(c.agentId)
      if (!p) continue // channel assigned to an agent not (yet) placed — skip
      // Conversation gating (§14): an Off conversation compiles NO route for a
      // GATED owner (fail-closed until an editor enables it). For a non-gated
      // owner a preserved row is inert (§14.4): a channel keeps its
      // mention-trigger ownership (matching integrationToSpec()), while an im
      // row compiles nothing at all — §14 DM rows only steer gated members;
      // non-gated DMs route via defaultAgentId as they always did.
      if (c.kind === 'im' && (!p.gated || c.trigger === 'off')) continue
      if (c.trigger === 'off' && p.gated) continue
      // A DM conversation row activates on any message once enabled (no mention
      // inside a DM); channels follow their trigger.
      const match: BindMatch = c.kind === 'im' || c.trigger === 'any' ? { kind: 'auto' } : { kind: 'mention' }
      routes.push({
        agentId: p.integration.agentId,
        daemonId: p.daemonId,
        integrationId: p.integration.id,
        scope: { channel: c.channelId },
        match
      })
      if (c.kind === 'im' && p.gated) {
        // Slug disambiguation inside a shared DM enabled for SEVERAL gated agents
        // (§14.3): a conversation-scoped keyword outranks the scoped auto in the
        // relay's arbitration, so "<slug> …" names this agent while an unslugged
        // DM falls to the first enabled auto route. (Unscoped keyword stays
        // forbidden for gated agents.)
        const slug = agentById.get(c.agentId)?.name
        if (slug) {
          routes.push({
            agentId: p.integration.agentId,
            daemonId: p.daemonId,
            integrationId: p.integration.id,
            scope: { channel: c.channelId },
            match: { kind: 'keyword', value: slug }
          })
        }
      }
    }

    // 2. keyword disambiguation (§10.2): one keyword rule per agent = its slug, so
    //    "@bot <slug> …" routes to that agent. No unscoped mention rule — that would
    //    starve keyword arbitration (§10.4).
    for (const p of placed) {
      const a = agentById.get(p.integration.agentId)
      if (!a) continue
      // Conversation gating (§14): no UNSCOPED rung may name a gated agent — the
      // keyword slug would make "@bot <slug>" fail-open in every conversation.
      if (isGatedAgent(a)) continue
      routes.push({
        agentId: p.integration.agentId,
        daemonId: p.daemonId,
        integrationId: p.integration.id,
        match: { kind: 'keyword', value: a.name }
      })
    }

    // 3. default agent (§10.3): the earliest NON-GATED install of the group catches
    //    a bare @bot + DMs. Delivered as `defaultAgentId` (the relay's fallback
    //    rung), not a route, so it never pre-empts keyword/channel arbitration. A
    //    gated agent must never be the fallback (§14: the bare-@bot/DM rungs are
    //    what make a shared bot fail-open); a group of only gated agents has none.
    const first = placed.find((p) => !p.gated)
    const agents = placed.map((p) => {
      const a = agentById.get(p.integration.agentId)
      return {
        agentId: p.integration.agentId,
        name: a?.displayName || a?.name || p.integration.agentId,
        daemonId: p.daemonId
      }
    })
    const dmPrefix = `${bot.id}:`
    const noticedDmConversations = [...this.noticedDms]
      .filter((k) => k.startsWith(dmPrefix))
      .map((k) => k.slice(dmPrefix.length))
    return {
      platform: bot.platform === 'slack' ? 'slack' : bot.platform === 'telegram' ? 'telegram' : 'discord',
      members,
      agents,
      routes,
      ...(first ? { defaultAgentId: first.integration.agentId, defaultDaemonId: first.daemonId } : {}),
      gatedAgentIds: placed.filter((p) => p.gated).map((p) => p.integration.agentId),
      noticedDmConversations,
      placed: placed.map((p) => ({ integration: p.integration, daemonId: p.daemonId, gated: p.gated }))
    }
  }

  /** Deliver the shared (send-only) spec to each member agent's daemon (best-effort).
   *  `shareable` rides each spec so the daemon knows whether to expose "Switch agent". */
  private async pushSpecs(
    compiled: Compiled,
    secret: BotSecretMaterial,
    bot: Pick<BotRecord, 'shareable' | 'slackAppId'>
  ): Promise<void> {
    // A gated install's spec carries its conversation-scoped rules for the daemon's
    // last-hop admission backstop (§14.3). One listForBot covers every install; rows
    // are keyed per install, so filter by integrationId.
    const anyGated = compiled.placed.some((p) => p.gated)
    const botChannels =
      anyGated && compiled.placed[0] ? await this.channels.listForBot(BotId(compiled.placed[0].integration.botId)) : []
    for (const { integration, daemonId, gated } of compiled.placed) {
      try {
        const channels = gated ? botChannels.filter((c) => c.integrationId === integration.id) : []
        await this.control.integrationUpsert(
          daemonId,
          sharedIntegrationToSpec(integration, secret, bot.shareable, channels, gated, bot.slackAppId ?? undefined)
        )
      } catch (err) {
        if (!(err instanceof NoConnection)) throw err
        this.log.debug?.({ integrationId: integration.id, daemonId }, 'shared-bot: spec push skipped — daemon offline')
      }
    }
  }

  /** Assemble the `rc/bot-assign` frame (credentials + attributed routing table).
   *  Secret — NEVER log the result. Callers guard signingSecret non-null for Slack. */
  private buildAssign(bot: BotRecord, compiled: Compiled, secret: BotSecretMaterial): RcBotAssign {
    return {
      botId: bot.id,
      platform: compiled.platform,
      // Slack app id ("A…", == Events API api_app_id) — O(1) inbound demux. Absent on
      // a manual-paste http bot (no xapp to parse); the relay verify-scans instead.
      ...(bot.slackAppId ? { apiAppId: bot.slackAppId } : {}),
      secrets: { botToken: secret.botToken, signingSecret: secret.signingSecret ?? '' },
      members: compiled.members,
      agents: compiled.agents,
      routes: compiled.routes,
      ...(compiled.defaultAgentId ? { defaultAgentId: compiled.defaultAgentId } : {}),
      ...(compiled.defaultDaemonId ? { defaultDaemonId: compiled.defaultDaemonId } : {}),
      gatedAgentIds: compiled.gatedAgentIds,
      noticedDmConversations: compiled.noticedDmConversations,
      ...(this.noticeAuthorityFor(bot.id) ? { noticeAuthority: this.noticeAuthorityFor(bot.id) } : {})
    }
  }

  /** Fan a C→R EVT to EVERY connected relay, per-socket isolated (a dead socket's
   *  error is swallowed; its onClose removes it from the registry). */
  private broadcast(send: (ch: RelayChannel) => void): void {
    for (const ch of this.relayReg.all()) {
      try {
        send(ch)
      } catch {
        // dead socket — its onClose removes it from the registry
      }
    }
  }
}
