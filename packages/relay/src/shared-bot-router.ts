/**
 * `SharedBotRouter` (shared-bot-relay.md §10) — the relay-side arbitration table
 * for shared bots. Holds each assigned bot's attributed routing table (pushed by
 * the CP via `rc/bot-assign` / `rc/routes`) plus live thread affinity, and
 * resolves one inbound message to its target `{ agentId, daemonId, integrationId }`.
 *
 * The ladder mirrors the daemon's local arbitration (routing-table.ts) but over
 * ALREADY-ATTRIBUTED routes, and adapted for the shared-bot ambiguity (all agents
 * answer as one bot user id): channel ownership → thread continuity → keyword
 * (agent slug) → the group's default agent for a bare @bot / DM. There is NO
 * unscoped mention rule (it would starve keyword disambiguation, §10.4); the bare
 * @bot fallback is the `defaultAgentId` rung instead.
 *
 * Pure data + a pure `arbitrate()` — no I/O, no Slack, no sockets — so it unit
 * tests without a live ingest.
 */
import type { AttributedRoute, WireNormalizedMessage } from '@agentconnect.md/protocol'

/** A bot's full relay-side assignment (from `rc/bot-assign`). Secret material. */
export interface BotAssignment {
  botId: string
  platform: 'slack' | 'telegram' | 'discord'
  secrets: { botToken: string; signingSecret: string }
  /** Slack app id (== Events API `api_app_id`) — the O(1) HTTP demux key when present. */
  apiAppId?: string
  /** Resolved lazily by the ingest (auth.test) — used for mention + echo suppression. */
  botUserId?: string
  members: { daemonId: string; agentIds: string[] }[]
  /** Member directory (id→name) — the options for the config modal's agent selector. */
  agents: { agentId: string; name: string }[]
  routes: AttributedRoute[]
  defaultAgentId?: string
  defaultDaemonId?: string
  /** Conversation-gated members (resource-visibility.md §14): thread continuity to
   *  one of these agents is honoured only while it still has a channel-scoped route
   *  in the conversation — a binding made before the gate was applied must not keep
   *  routing a private agent in a now-Off conversation. */
  gatedAgentIds?: string[]
  /** §14.3: the relayId deterministically responsible for this bot's one-time
   *  CHANNEL gating notices (stamped by the CP from the connected roster). */
  noticeAuthority?: string
  /** §14.3: DM conversation ids whose notice was ACTUALLY DELIVERED (pool-wide
   *  latch for single-copy DM messages; never mere row discovery). */
  noticedDmConversations?: string[]
}

/** The arbitration verdict — a target the daemon dispatches to. */
export interface RouteTarget {
  agentId: string
  daemonId: string
  integrationId: string
}

/** `channel/thread` — the per-conversation affinity + rc/assign key. */
export function sessionKeyOf(msg: Pick<WireNormalizedMessage, 'channel' | 'thread'>): string {
  return `${msg.channel}/${msg.thread ?? msg.channel}`
}

function scopeMatches(r: AttributedRoute, msg: WireNormalizedMessage): boolean {
  if (r.scope?.channel !== undefined && r.scope.channel !== msg.channel) return false
  if (r.scope?.thread !== undefined && r.scope.thread !== msg.thread) return false
  return true
}

function kindMatches(r: AttributedRoute, msg: WireNormalizedMessage, botUserId: string | undefined): boolean {
  switch (r.match.kind) {
    case 'mention':
      return botUserId !== undefined && msg.mentionedBots.includes(botUserId)
    case 'dm':
      return msg.isDm
    case 'keyword':
      return msg.text.toLowerCase().includes(r.match.value.toLowerCase())
    case 'auto':
      return true
  }
}

const target = (r: AttributedRoute): RouteTarget => ({
  agentId: r.agentId,
  daemonId: r.daemonId,
  integrationId: r.integrationId
})

/**
 * Arbitrate one inbound message against a bot's attributed routes (pure).
 * `affinity` maps a sessionKey to a prior target (thread continuity), refreshed by
 * the caller after each routed turn and seeded durably by `rc/assign`.
 */
export function arbitrate(
  a: BotAssignment,
  msg: WireNormalizedMessage,
  affinity: Map<string, RouteTarget>
): RouteTarget | null {
  // Own echoes never route. A third-party Slack bot may enter only through an
  // explicit mention; AgentConnect-managed app messages are removed by the manager
  // using the collaboration snapshot before forwarding.
  if (a.botUserId !== undefined && msg.sender.id === a.botUserId) return null
  const explicitlyMentioned = a.botUserId !== undefined && msg.mentionedBots.includes(a.botUserId)
  if (msg.sender.isBot && (msg.platform !== 'slack' || !explicitlyMentioned)) return null

  const scoped = a.routes.filter((r) => r.scope?.channel !== undefined && scopeMatches(r, msg))

  // 1. Channel ownership (§10.1, the primary path): a channel-scoped rule that
  //    matches the message kind wins outright (mention rule needs the @bot; auto
  //    rule fires on any message — the operator's trigger choice).
  const ownedMention = scoped.find((r) => r.match.kind === 'mention' && kindMatches(r, msg, a.botUserId))
  if (ownedMention) return target(ownedMention)
  // Conversation-scoped keyword (§14.3): slug disambiguation inside a shared DM
  // enabled for several gated agents — outranks the scoped auto so "<slug> …"
  // names its agent; an unslugged message falls through to the first auto route.
  const ownedKeyword = scoped.find((r) => r.match.kind === 'keyword' && kindMatches(r, msg, a.botUserId))
  if (ownedKeyword) return target(ownedKeyword)
  const ownedAuto = scoped.find((r) => r.match.kind === 'auto')
  if (ownedAuto) return target(ownedAuto)

  // 2. Thread continuity: an un-mentioned follow-up in a thread the relay already
  //    routed continues to that agent, provided it is still a member — and, for a
  //    conversation-gated agent (§14), provided the conversation is still enabled
  //    (a channel-scoped route for that agent exists). The affinity map is not
  //    scope-filtered, so without this check a pre-gate binding routes forever.
  const cont = affinity.get(sessionKeyOf(msg))
  const contGateOk = !cont || !a.gatedAgentIds?.includes(cont.agentId) || scoped.some((r) => r.agentId === cont.agentId)
  if (cont && contGateOk && a.members.some((m) => m.daemonId === cont.daemonId && m.agentIds.includes(cont.agentId))) {
    if (cont.integrationId) return cont
    const route = a.routes.find((r) => r.agentId === cont.agentId)
    if (route) return { ...cont, integrationId: route.integrationId }
    return cont
  }

  // 3. Keyword disambiguation (§10.2): "@bot <slug> …" → that agent. Only when the
  //    bot was actually addressed (a mention or a DM), so a stray slug substring in
  //    a normal channel message doesn't trigger it.
  const addressed = explicitlyMentioned || msg.isDm
  if (addressed) {
    const kw = a.routes.find((r) => r.match.kind === 'keyword' && !r.scope && kindMatches(r, msg, a.botUserId))
    if (kw) return target(kw)

    // 4. Default agent (§10.3): a bare @bot / DM with no slug → the group default.
    if (a.defaultAgentId && a.defaultDaemonId) {
      // Resolve the default's integrationId from its (keyword) route.
      const def = a.routes.find((r) => r.agentId === a.defaultAgentId)
      if (def) return { agentId: a.defaultAgentId, daemonId: a.defaultDaemonId, integrationId: def.integrationId }
    }
  }

  return null
}

/** Cap on a bot's negative-affinity set before it is flushed (bounds CP lookups). */
const MAX_NEGATIVE_AFFINITY = 10_000

export class SharedBotRouter {
  private readonly bots = new Map<string, BotAssignment>()
  /** Per-bot thread affinity: botId → (sessionKey → target). */
  private readonly affinity = new Map<string, Map<string, RouteTarget>>()
  /** Per-bot NEGATIVE affinity: sessionKeys the CP confirmed hold no owner. Prevents
   *  an un-owned thread's every follow-up from re-hitting the CP (`rc/thread-lookup`). */
  private readonly noAffinity = new Map<string, Set<string>>()

  upsert(a: BotAssignment): void {
    const prev = this.bots.get(a.botId)
    // Preserve a resolved botUserId across a routes-only hot update.
    if (prev?.botUserId && a.botUserId === undefined) a.botUserId = prev.botUserId
    this.bots.set(a.botId, a)
    if (!this.affinity.has(a.botId)) this.affinity.set(a.botId, new Map())
  }

  /** Replace routes/members/agents/default WITHOUT touching secrets or botUserId (rc/routes). */
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
      | 'noticeAuthority'
      | 'noticedDmConversations'
    >
  ): void {
    const a = this.bots.get(botId)
    if (!a) return
    a.members = patch.members
    a.agents = patch.agents
    a.routes = patch.routes
    a.defaultAgentId = patch.defaultAgentId
    a.defaultDaemonId = patch.defaultDaemonId
    a.gatedAgentIds = patch.gatedAgentIds
    a.noticeAuthority = patch.noticeAuthority
    a.noticedDmConversations = patch.noticedDmConversations
  }

  remove(botId: string): BotAssignment | undefined {
    const a = this.bots.get(botId)
    this.bots.delete(botId)
    this.affinity.delete(botId)
    this.noAffinity.delete(botId)
    return a
  }

  get(botId: string): BotAssignment | undefined {
    return this.bots.get(botId)
  }

  /** Resolve an opaque shared-status target to the current canonical daemon route.
   *  Both agentId and integrationId must still belong to this bot; stale/tampered
   *  buttons are rejected instead of falling through to a channel's current owner. */
  targetForAgent(botId: string, agentId: string, integrationId: string): RouteTarget | undefined {
    const a = this.bots.get(botId)
    if (!a) return undefined
    const routes = a.routes.filter((r) => r.agentId === agentId && r.integrationId === integrationId)
    if (routes.length === 0) return undefined
    const daemonIds = new Set(routes.map((r) => r.daemonId))
    // A target must resolve to one canonical daemon. Fail closed on an inconsistent
    // routing snapshot instead of letting route array order choose where a click goes.
    if (daemonIds.size !== 1) return undefined
    const route = routes[0]!
    if (!a.members.some((m) => m.daemonId === route.daemonId && m.agentIds.includes(agentId))) return undefined
    return target(route)
  }

  /** Resolve an agent picker value to one canonical route for this shared bot.
   *  Repeated scoped/keyword rules are fine when they point at the same integration;
   *  conflicting placements fail closed instead of choosing by array order. */
  targetForAgentId(botId: string, agentId: string): RouteTarget | undefined {
    const a = this.bots.get(botId)
    if (!a) return undefined
    const routes = a.routes.filter((r) => r.agentId === agentId)
    const targets = new Set(routes.map((r) => `${r.daemonId}\u0000${r.integrationId}`))
    if (targets.size !== 1) return undefined
    const route = routes[0]!
    if (!a.members.some((m) => m.daemonId === route.daemonId && m.agentIds.includes(agentId))) return undefined
    return target(route)
  }

  /** The agent that currently owns `channelId` (a channel-scoped route), if any —
   *  the config modal's initial selection. */
  channelOwner(botId: string, channelId: string): string | undefined {
    return this.bots.get(botId)?.routes.find((r) => r.scope?.channel === channelId)?.agentId
  }

  /** True iff `channelId` has a channel-scoped `auto` owner — a rule that fires on
   *  EVERY message. Such a channel needs no durable thread binding: any pod re-resolves
   *  every message (incl. un-mentioned follow-ups) via the channel-ownership rung
   *  before affinity is ever consulted, so reporting per-message would only amplify
   *  writes + grow `shared_thread_agent` unboundedly. */
  channelAutoOwned(botId: string, channelId: string): boolean {
    return this.bots.get(botId)?.routes.some((r) => r.scope?.channel === channelId && r.match.kind === 'auto') ?? false
  }

  /** Apply a channel-owner pick to the current routing snapshot immediately.
   *  The CP remains authoritative and will replace this optimistic update via
   *  `rc/routes`; preserving the existing match keeps the channel trigger stable. */
  setChannelOwner(botId: string, channelId: string, tgt: RouteTarget): void {
    const a = this.bots.get(botId)
    if (!a) return
    for (const route of a.routes) {
      if (route.scope?.channel !== channelId) continue
      route.agentId = tgt.agentId
      route.daemonId = tgt.daemonId
      route.integrationId = tgt.integrationId
    }
  }

  setBotUserId(botId: string, botUserId: string): void {
    const a = this.bots.get(botId)
    if (a) a.botUserId = botUserId
  }

  /** Durable thread affinity from `rc/assign` (survives relay restart / re-assign). */
  setAffinity(botId: string, sessionKey: string, tgt: RouteTarget): void {
    ;(this.affinity.get(botId) ?? this.affinity.set(botId, new Map()).get(botId)!).set(sessionKey, tgt)
    // A now-owned thread must leave the negative cache (a Switch-agent / late assign).
    this.noAffinity.get(botId)?.delete(sessionKey)
  }

  /** Read the current affinity for a thread WITHOUT resolving (the report leg's
   *  first-route / changed-target detection reads this before `route()` mutates it). */
  peekAffinity(botId: string, sessionKey: string): RouteTarget | undefined {
    return this.affinity.get(botId)?.get(sessionKey)
  }

  /**
   * True iff `msg` is a genuine un-mentioned follow-up IN A THREAD the relay holds no
   * affinity for — the only shape worth a CP `rc/thread-lookup`. Excludes: echoes,
   * addressed messages (a mention/DM route themselves), thread-root messages (own ts ==
   * thread ts), threads we already own, and threads the CP already said are un-owned.
   */
  isUnmentionedThreadFollowup(botId: string, msg: WireNormalizedMessage): boolean {
    const a = this.bots.get(botId)
    if (!a) return false
    if (msg.sender.isBot) return false
    if (a.botUserId !== undefined && msg.sender.id === a.botUserId) return false
    const addressed = (a.botUserId !== undefined && msg.mentionedBots.includes(a.botUserId)) || msg.isDm
    if (addressed) return false
    // The message's own ts is the tail of `slack:${channel}:${ts}` (split on last ':').
    const ownTs = msg.msgId.slice(msg.msgId.lastIndexOf(':') + 1)
    if (!msg.thread || msg.thread === ownTs) return false
    const sessionKey = sessionKeyOf(msg)
    if (this.affinity.get(botId)?.has(sessionKey)) return false
    if (this.noAffinity.get(botId)?.has(sessionKey)) return false
    return true
  }

  /** Seed affinity from a CP `rc/thread-lookup/ok` target: validate the agent is a
   *  current member of that daemon, backfill integrationId from its route, install the
   *  affinity. Returns the seeded target, or null if the agent is not a current member. */
  seedLookupTarget(
    botId: string,
    sessionKey: string,
    lookup: { agentId: string; daemonId: string }
  ): RouteTarget | null {
    const a = this.bots.get(botId)
    if (!a) return null
    if (!a.members.some((m) => m.daemonId === lookup.daemonId && m.agentIds.includes(lookup.agentId))) return null
    const route = a.routes.find((r) => r.agentId === lookup.agentId)
    const tgt: RouteTarget = {
      agentId: lookup.agentId,
      daemonId: lookup.daemonId,
      integrationId: route?.integrationId ?? ''
    }
    this.setAffinity(botId, sessionKey, tgt)
    return tgt
  }

  /** Record that the CP holds NO owner for `sessionKey` (a `rc/thread-lookup/ok` miss),
   *  so subsequent un-mentioned follow-ups in the same thread don't re-hit the CP. */
  rememberNoAffinity(botId: string, sessionKey: string): void {
    let set = this.noAffinity.get(botId)
    if (!set) {
      set = new Set()
      this.noAffinity.set(botId, set)
    }
    if (set.size >= MAX_NEGATIVE_AFFINITY) set.clear()
    set.add(sessionKey)
  }

  /** Resolve one message; records live affinity for the resolved thread. */
  route(botId: string, msg: WireNormalizedMessage): RouteTarget | null {
    const a = this.bots.get(botId)
    if (!a) return null
    const aff = this.affinity.get(botId) ?? this.affinity.set(botId, new Map()).get(botId)!
    const tgt = arbitrate(a, msg, aff)
    if (tgt) aff.set(sessionKeyOf(msg), tgt)
    return tgt
  }

  /** Every currently-assigned bot (ingest lifecycle reconciliation). */
  all(): BotAssignment[] {
    return [...this.bots.values()]
  }
}
