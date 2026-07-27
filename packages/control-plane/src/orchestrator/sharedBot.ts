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
  /** Placed member integrations (spec push targets: daemonId + integration). */
  placed: { integration: IntegrationRecord; daemonId: string; gated: boolean }[]
}

export class SharedBotOrchestrator {
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
    await this.pushSpecs(compiled, secret, bot.shareable)
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
        gatedAgentIds: compiled.gatedAgentIds
      })
    )
    const secret = await this.botSecret.get(bot.id)
    if (secret) await this.pushSpecs(compiled, secret, bot.shareable)
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
   *  A freshly-invited channel is seeded with the bot's CREATING agent as its
   *  default owner (§10.1), so it routes out of the box instead of landing on
   *  "No default" (a bare mention would fall to the group default, but an
   *  "any message" channel with no owner routes nothing). Only genuinely NEW
   *  channels are seeded — a channel the operator later clears to "No default"
   *  stays cleared, never re-seeded. The seed is written on the creating install's
   *  row alone, preserving the one-owner-per-channel invariant.
   */
  async replaceChannels(botId: string, channels: ReportedChannel[]): Promise<void> {
    const bot = await this.bots.get(BotId(botId))
    if (!bot || bot.platform !== 'slack' || bot.transport !== 'http') {
      this.log.warn({ botId }, 'shared-bot: channel snapshot for a non-http/unknown Slack bot — ignored')
      return
    }
    const installs = await this.integrations.listForBot(bot.id)
    // Channels already known (on ANY install) before this snapshot — the set we must
    // NOT seed, so an operator's later "No default" clear is honoured, not overwritten.
    const known = new Set((await this.channels.listForBot(bot.id)).map((c) => c.channelId))
    for (const integration of installs) {
      // Conversation gating (§14): a gated install's fresh channels start Off — an
      // editor must enable them in the console before the compiler emits a route.
      const owner = await this.agents.get(integration.agentId)
      const defaultTrigger = owner && isGatedAgent(owner) ? ('off' as const) : undefined
      await this.channels.replaceSnapshot(integration.id, channels, defaultTrigger ? { defaultTrigger } : undefined)
    }
    // The creating agent = the earliest install (`listForBot` is createdAt-asc). Own
    // each new channel on its row so the channel-scoped rule the compiler reads points
    // at the creating agent (and no other install co-owns it). Operator-overridable.
    const creating = installs[0]
    if (creating) {
      for (const c of channels) {
        if (!known.has(c.id)) await this.channels.upsertAgent(creating.id, c.id, creating.agentId)
      }
    }
    await this.syncRoutes(botId)
  }

  /**
   * Set (or clear) a channel's default/owning agent for a shared bot — the target of
   * the in-Slack config modal (`rc/set-channel-agent`). Channel ownership is one
   * agent per channel, but rows are keyed per-install, so this makes the pick the
   * SOLE owner: it clears the channel's row on every OTHER install of the bot, then
   * upserts it (with `agentId`) on the chosen agent's own install — which is what the
   * route compiler reads as the channel-scoped rule. `agentId: null` just clears.
   * Recompiles + pushes the bot's routes (`rc/routes`). Fire-and-forget safe.
   */
  async setChannelAgent(botId: string, channelId: string, agentId: string | null): Promise<void> {
    const bot = await this.bots.get(BotId(botId))
    if (bot?.transport !== 'http') {
      this.log.warn({ botId }, 'shared-bot: set-channel-agent for a non-http/unknown bot — ignored')
      return
    }
    const installs = await this.integrations.listForBot(bot.id)
    // The chosen owner must actually be an agent installed on this bot.
    const owner = agentId ? installs.find((i) => i.agentId === agentId) : undefined
    if (agentId && !owner) {
      this.log.warn({ botId, agentId }, 'shared-bot: set-channel-agent for a non-member agent — ignored')
      return
    }
    // One owner per channel: drop this channel's row on every other install, then set
    // it (name/isPrivate default in the daemon-report sense are irrelevant here — the
    // row exists purely to carry the agentId ownership the compiler reads).
    for (const i of installs) {
      if (owner && i.id === owner.id) continue
      await this.channels.setAgent(i.id, channelId, null)
    }
    if (owner) {
      // Conversation gating (§14): the in-Slack config modal is reachable by any
      // workspace user, so assigning a channel to a GATED agent must not enable it —
      // a freshly-created row starts Off; only a console editor can flip the trigger.
      const ownerAgent = await this.agents.get(owner.agentId)
      const defaultTrigger = ownerAgent && isGatedAgent(ownerAgent) ? ('off' as const) : undefined
      await this.channels.upsertAgent(
        owner.id,
        channelId,
        AgentId(agentId!),
        defaultTrigger ? { defaultTrigger } : undefined
      )
    }
    await this.syncRoutes(botId)
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Compile the attributed routing table from the bot's installs + channels. */
  private async compile(bot: BotRecord): Promise<Compiled | null> {
    const integrations = await this.integrations.listForBot(bot.id)
    if (integrations.length === 0) return null
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
      // Conversation gating (§14): an Off conversation compiles NO route — for a
      // gated owner that is the fail-closed default until an editor enables it.
      if (c.trigger === 'off') continue
      const p = byAgent.get(c.agentId)
      if (!p) continue // channel assigned to an agent not (yet) placed — skip
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
    return {
      platform: bot.platform === 'slack' ? 'slack' : bot.platform === 'telegram' ? 'telegram' : 'discord',
      members,
      agents,
      routes,
      ...(first ? { defaultAgentId: first.integration.agentId, defaultDaemonId: first.daemonId } : {}),
      gatedAgentIds: placed.filter((p) => p.gated).map((p) => p.integration.agentId),
      placed: placed.map((p) => ({ integration: p.integration, daemonId: p.daemonId, gated: p.gated }))
    }
  }

  /** Deliver the shared (send-only) spec to each member agent's daemon (best-effort).
   *  `shareable` rides each spec so the daemon knows whether to expose "Switch agent". */
  private async pushSpecs(compiled: Compiled, secret: BotSecretMaterial, shareable: boolean): Promise<void> {
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
          sharedIntegrationToSpec(integration, secret, shareable, channels, gated)
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
      gatedAgentIds: compiled.gatedAgentIds
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
