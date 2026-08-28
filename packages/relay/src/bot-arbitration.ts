/**
 * `BotArbitrationRouter` (shared-bot-relay.md §10) — the relay-side arbitration table
 * for HTTP bots. Holds each assigned bot's attributed routing table (pushed by
 * the CP via `rc/bot-assign` / `rc/routes`) plus live thread affinity, and
 * resolves one inbound message to its target `{ agentId, daemonId, integrationId }`.
 *
 * The ladder mirrors the daemon's local arbitration (routing-table.ts) but over
 * ALREADY-ATTRIBUTED routes, and adapted for the multi-agent ambiguity (all agents
 * answer as one bot user id): channel ownership → thread continuity → keyword
 * (agent slug) → the group's default agent for a bare @bot / DM. There is NO
 * unscoped mention rule (it would starve keyword disambiguation, §10.4); the bare
 * @bot fallback is the `defaultAgentId` rung instead.
 *
 * Pure data + a pure `arbitrate()` — no I/O, no Slack, no sockets — so it unit
 * tests without a live ingest.
 */
import { arbitrateSharedBot, sharedBotScopeMatches, sharedBotSessionKey } from '@agentconnect.md/activation-policy'
import type { AttributedRoute, RcAgentDirEntry, RcBotAssign, WireNormalizedMessage } from '@agentconnect.md/protocol'
import { isThreadRootMessage } from '@agentconnect.md/message'

/** A bot's full relay-side assignment (from `rc/bot-assign`). Secret material. */
export interface BotAssignment {
  botId: string
  // S1a open reader (protocol route.ts Platform policy): the wire field is an
  // open string; the assign handler refuses an unsupported platform gracefully.
  platform: string
  secrets: { botToken: string; signingSecret: string } | { verificationToken: string; encryptKey?: string }
  /** Provider app id — the O(1) HTTP demux key when present. */
  apiAppId?: string
  /** Slack workspace id (== Events API `team_id`). Present ⇒ this bot is one
   *  workspace install of a DISTRIBUTED app: every sibling install shares the app
   *  id AND the signing secret, so this bot may only be demuxed on the composite
   *  `(api_app_id, team_id)` key — never by app id or signature scan alone. */
  teamId?: string
  /** The tenant this assignment belongs to, captured for EVERY install kind —
   *  unlike {@link BotAssignment.teamId}, which the CP sets only for a
   *  distributed app's install. NOT a demux index key: it is the ingress tenant
   *  FENCE (ingress-tenant-fence.md §3). `verify` proves a delivery was signed
   *  with this app's signing secret; the fence proves it came from this bot's
   *  workspace, which a same-secret sibling in another organization would
   *  otherwise satisfy just as well. */
  workspaceId?: string
  /** Install GENERATION of `secrets` (CP-assigned). Echoed back on `rc/bot-revoked`
   *  so the CP can refuse a revocation that was observed under a credential a
   *  re-install has since replaced — Slack does not order lifecycle events. */
  credentialRevision?: number
  /** Provider bot identity — used for mention + echo suppression. */
  botUserId?: string
  members: { daemonId: string; agentIds: string[] }[]
  /** Member directory (id→name) — the options for the config modal's agent selector. */
  agents: { agentId: string; name: string; daemonId?: string; integrationId?: string }[]
  routes: AttributedRoute[]
  defaultAgentId?: string
  defaultDaemonId?: string
  /** Conversation-gated members (resource-visibility.md §14): thread continuity to
   *  one of these agents is honoured only while it still has a channel-scoped route
   *  in the conversation — a binding made before the gate was applied must not keep
   *  routing a private agent in a now-Off conversation. */
  gatedAgentIds?: string[]
  /** Channels switched OFF. The ladder below has rungs no missing route can suppress
   *  — thread continuity, the unscoped keyword slug, `defaultAgentId` — so Off is a
   *  fence rather than an omission: a muted channel resolves to nothing. */
  mutedChannels?: string[]
  /** The muted channels whose owner is GATED (§14 never enabled them). They resolve to
   *  nothing like any mute, but unlike an operator's mute they keep the one-time notice:
   *  someone who could not know the agent is private must not meet a dead bot. */
  gatedOffChannels?: string[]
  /** §14.3: the relayId deterministically responsible for this bot's one-time
   *  CHANNEL gating notices (stamped by the CP from the connected roster). */
  noticeAuthority?: string
  /** §14.3: DM conversation ids whose notice was ACTUALLY DELIVERED (pool-wide
   *  latch for single-copy DM messages; never mere row discovery). */
  noticedDmConversations?: string[]
}

/** Keep the directory shape identical on full assignments and `rc/routes` updates. */
export function mapAgentDirectory(entries: readonly RcAgentDirEntry[]): BotAssignment['agents'] {
  return entries.map((entry) => ({
    agentId: entry.agentId,
    name: entry.name,
    daemonId: entry.daemonId,
    ...(entry.integrationId ? { integrationId: entry.integrationId } : {})
  }))
}

/** The arbitration verdict — a target the daemon dispatches to. */
export interface RouteTarget {
  agentId: string
  daemonId: string
  integrationId: string
}

export interface ConversationTarget {
  target: RouteTarget
  /** Explicit only for a human mention. Agent-authored traffic can join a peer by
   * mention, but remains implicit so it cannot clear a human's `!stop` latch. */
  via: 'mention' | 'implicit'
}

/** `channel/thread` — the per-conversation affinity + rc/assign key. Package
 *  policy since the relay fold-in; re-exported to keep the import path. */
export const sessionKeyOf: (msg: Pick<WireNormalizedMessage, 'channel' | 'thread'>) => string = sharedBotSessionKey

const scopeMatches: (r: AttributedRoute, msg: WireNormalizedMessage) => boolean = sharedBotScopeMatches

const target = (r: AttributedRoute): RouteTarget => ({
  agentId: r.agentId,
  daemonId: r.daemonId,
  integrationId: r.integrationId
})

/**
 * Arbitrate one inbound message against a bot's attributed routes (pure).
 * `affinity` maps a sessionKey to a prior target (thread continuity), refreshed by
 * the caller after each routed turn and seeded durably by `rc/assign`.
 *
 * Since the relay fold-in the ladder itself is package-owned policy
 * (`arbitrateSharedBot`, `@agentconnect.md/activation-policy` — see its header
 * for the declared ladder structure and how it relates to the daemon ladder);
 * `BotAssignment` structurally satisfies the package's assignment facts, and
 * this module keeps the stateful remainder (the affinity/participant
 * bookkeeping and the peer fan-out below).
 */
export function arbitrate(
  a: BotAssignment,
  msg: WireNormalizedMessage,
  affinity: Map<string, RouteTarget>,
  /** send-message-routing-rework.md §2.3: a VERIFIED AgentConnect author routes through
   *  this ladder exactly as a human would, with itself excluded so it cannot self-wake.
   *  Unverified bots — including third-party ones — still stop at the explicit mention. */
  verifiedAgentAuthor?: string
): RouteTarget | null {
  return arbitrateSharedBot(a, msg, affinity, verifiedAgentAuthor)
}

/** Cap on a bot's negative-affinity set before it is flushed (bounds CP lookups). */
const MAX_NEGATIVE_AFFINITY = 10_000
const MAX_PARTICIPANT_CONVERSATIONS = 10_000

export class BotArbitrationRouter {
  private readonly bots = new Map<string, BotAssignment>()
  /** Per-bot thread affinity: botId → (sessionKey → target). */
  private readonly affinity = new Map<string, Map<string, RouteTarget>>()
  /** Every agent that has joined a conversation on this HTTP bot. Unlike `affinity`,
   * this is a set: a shared-bot thread can span several daemons and has no single owner. */
  private readonly participants = new Map<string, Map<string, Map<string, RouteTarget>>>()
  /** Per-bot NEGATIVE affinity: sessionKeys the CP confirmed hold no owner. Prevents
   *  an un-owned thread's every follow-up from re-hitting the CP (`rc/thread-lookup`). */
  private readonly noAffinity = new Map<string, Set<string>>()

  upsert(a: BotAssignment): void {
    const prev = this.bots.get(a.botId)
    // Preserve a resolved botUserId across a routes-only hot update.
    if (prev?.botUserId && a.botUserId === undefined) a.botUserId = prev.botUserId
    this.bots.set(a.botId, a)
    if (!this.affinity.has(a.botId)) this.affinity.set(a.botId, new Map())
    if (!this.participants.has(a.botId)) this.participants.set(a.botId, new Map())
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
      | 'mutedChannels'
      | 'gatedOffChannels'
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
    a.mutedChannels = patch.mutedChannels
    a.gatedOffChannels = patch.gatedOffChannels
    a.noticeAuthority = patch.noticeAuthority
    a.noticedDmConversations = patch.noticedDmConversations
  }

  remove(botId: string): BotAssignment | undefined {
    const a = this.bots.get(botId)
    this.bots.delete(botId)
    this.affinity.delete(botId)
    this.participants.delete(botId)
    this.noAffinity.delete(botId)
    return a
  }

  get(botId: string): BotAssignment | undefined {
    return this.bots.get(botId)
  }

  /** Resolve an opaque relay-status target to the current canonical daemon route.
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

  /** Resolve one explicitly rendered integration through the current member
   * directory. Unlike message routing, a card action does not require a still-live
   * conversation rule: the daemon's active-card map is its terminal fence. */
  integrationTarget(botId: string, agentId: string, integrationId: string): RouteTarget | undefined {
    const a = this.bots.get(botId)
    if (!a) return undefined
    const candidates = a.agents.filter(
      (entry) => entry.agentId === agentId && entry.integrationId === integrationId && entry.daemonId !== undefined
    )
    if (candidates.length !== 1) return undefined
    const candidate = candidates[0]!
    if (!a.members.some((m) => m.daemonId === candidate.daemonId && m.agentIds.includes(candidate.agentId))) {
      return undefined
    }
    return { agentId: candidate.agentId, daemonId: candidate.daemonId!, integrationId }
  }

  /** Resolve an agent picker value to one canonical route for this HTTP bot.
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

  /** Resolve a bot that has exactly one fully-attributed integration. This is the
   * rolling-compatibility fallback for Lark / Feishu cards rendered before their
   * action value carried an explicit agent + integration target. */
  soleTarget(botId: string): RouteTarget | undefined {
    const a = this.bots.get(botId)
    if (!a) return undefined
    const candidates = a.agents.flatMap((entry) =>
      entry.daemonId && entry.integrationId
        ? [{ agentId: entry.agentId, daemonId: entry.daemonId, integrationId: entry.integrationId }]
        : []
    )
    if (candidates.length !== 1) return undefined
    const candidate = candidates[0]!
    if (!a.members.some((m) => m.daemonId === candidate.daemonId && m.agentIds.includes(candidate.agentId))) {
      return undefined
    }
    return candidate
  }

  /**
   * Resolve the sole gated install without relying on a routing rule. A fully
   * gated bot deliberately compiles no unscoped route, but Feishu callback
   * credentials are receive-only: its daemon must still receive an addressed
   * Off-conversation message so it can discover the row and post the notice.
   */
  soleGatedTarget(botId: string): RouteTarget | undefined {
    const a = this.bots.get(botId)
    if (!a) return undefined
    const gated = new Set(a.gatedAgentIds ?? [])
    const candidates = a.agents.flatMap((entry) =>
      gated.has(entry.agentId) && entry.daemonId && entry.integrationId
        ? [{ agentId: entry.agentId, daemonId: entry.daemonId, integrationId: entry.integrationId }]
        : []
    )
    if (candidates.length !== 1) return undefined
    const candidate = candidates[0]!
    if (!a.members.some((m) => m.daemonId === candidate.daemonId && m.agentIds.includes(candidate.agentId))) {
      return undefined
    }
    return candidate
  }

  /** True iff `channelId` is Off. `arbitrate()` already refuses it; the caller needs
   *  this to tell a mute apart from the other reasons arbitration returns null. */
  channelMuted(botId: string, channelId: string): boolean {
    return this.bots.get(botId)?.mutedChannels?.includes(channelId) ?? false
  }

  /** True iff `channelId` is Off because §14 never enabled its gated owner — the one
   *  muted case that still speaks, once, to say the agent is private. */
  channelGatedOff(botId: string, channelId: string): boolean {
    return this.bots.get(botId)?.gatedOffChannels?.includes(channelId) ?? false
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
    this.setParticipant(botId, sessionKey, tgt)
    // A now-owned thread must leave the negative cache (a Switch-agent / late assign).
    this.noAffinity.get(botId)?.delete(sessionKey)
  }

  /** Durable conversation member from an `rc/participant-assign` projection. */
  setParticipant(botId: string, sessionKey: string, tgt: RouteTarget): void {
    const byConversation = this.participants.get(botId) ?? this.participants.set(botId, new Map()).get(botId)!
    const members = byConversation.get(sessionKey) ?? new Map<string, RouteTarget>()
    if (!byConversation.has(sessionKey)) {
      if (byConversation.size >= MAX_PARTICIPANT_CONVERSATIONS) byConversation.clear()
      byConversation.set(sessionKey, members)
    }
    members.set(tgt.agentId, tgt)
  }

  /** The remembered participant set of one conversation, re-resolved through the current
   *  member directory so each target carries the daemon that holds the agent NOW, with the
   *  mute and gating fences applied. The recipients of a conversation-addressed session
   *  event that must reach every participant (the native Stop), not one arbitrated owner. */
  conversationParticipants(botId: string, sessionKey: string, channelId: string): RouteTarget[] {
    const remembered = this.participants.get(botId)?.get(sessionKey)
    if (!remembered) return []
    const targets: RouteTarget[] = []
    for (const agentId of remembered.keys()) {
      const target = this.agentTarget(botId, agentId, channelId)
      if (target) targets.push(target)
    }
    return targets
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
    // A thread ROOT routes itself (its own send established the affinity) — only
    // genuine follow-ups are worth a lookup. The coordinate parse belongs to the
    // message package, which mints the `platform:channel:native` format.
    if (!msg.thread || isThreadRootMessage(msg)) return false
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

  /**
   * Resolve a NAMED agent to its route on this bot, bypassing the arbitration ladder
   * entirely (send-message-routing-rework.md §6).
   *
   * This is the verified-agent-author path: the target came from a recipient set the
   * author's daemon resolved and the relay verified, so there is nothing to arbitrate.
   * Bypassing the ladder is the point, not a shortcut — it is what keeps an agent
   * message off thread affinity, keyword matching, and the `defaultAgentId` fallback,
   * so a bare shared-bot mention (which resolves to no agent, §8.5) can never be turned
   * into "the channel's default agent" here.
   *
   * Still membership-checked: the agent must be a current member of this bot on a live
   * daemon, exactly as every other resolution path requires. Null otherwise.
   */
  agentTarget(botId: string, agentId: string, channelId: string): RouteTarget | null {
    const a = this.bots.get(botId)
    if (!a) return null
    // A channel switched Off resolves to no target at all — the same fence `arbitrate`
    // applies ahead of every rung. Bypassing the ladder must not mean bypassing this:
    // Off means the agent does not respond there, explicitly including an @-mention, so
    // an agent mention must not become the one way into a silenced channel.
    if (a.mutedChannels?.includes(channelId)) return null
    const member = a.members.find((m) => m.agentIds.includes(agentId))
    const route = a.routes.find((r) => r.agentId === agentId)
    const daemonId = member?.daemonId ?? route?.daemonId ?? a.agents.find((x) => x.agentId === agentId)?.daemonId
    if (!daemonId) return null
    // A conversation-GATED agent (§14) is reachable only while it still holds a
    // channel-scoped route here — a binding made before the gate was applied must not keep
    // routing a private agent into a now-Off conversation.
    if (a.gatedAgentIds?.includes(agentId)) {
      const scoped = a.routes.some((r) => r.agentId === agentId && r.scope?.channel === channelId)
      if (!scoped) return null
    }
    const integrationId = route?.integrationId ?? a.agents.find((x) => x.agentId === agentId)?.integrationId
    if (!integrationId) return null
    return { agentId, daemonId, integrationId }
  }

  /**
   * Resolve an AgentConnect-authored message through the ordinary ladder, with the
   * verified author excluded (send-message-routing-rework.md §2.3).
   *
   * Deliberately does NOT record thread affinity: an agent continuing a conversation is
   * not the same event as a human establishing who owns the thread, and letting agent
   * traffic rewrite the binding would let two agents hand ownership back and forth away
   * from the human who started it.
   */
  routeAgentAuthored(botId: string, msg: WireNormalizedMessage, authorAgentId: string): RouteTarget | null {
    const a = this.bots.get(botId)
    if (!a) return null
    const aff = this.affinity.get(botId) ?? new Map<string, RouteTarget>()
    return arbitrate(a, msg, aff, authorAgentId)
  }

  /** Resolve every recipient of one conversation event and remember the joined set.
   *
   * The ordinary ladder may still produce a primary for compatibility/reporting, but it
   * does not bound delivery. Existing participants, every newly mentioned route, and
   * every scoped `auto` route are independent targets. This state lives beside affinity
   * because affinity intentionally models one legacy owner and collapses in the exact
   * multi-agent shape this method serves. */
  conversationTargets(
    botId: string,
    msg: WireNormalizedMessage,
    primary?: RouteTarget | null,
    verifiedAgentAuthor?: string,
    joinedAgentIds: readonly string[] = [],
    onJoin?: (target: RouteTarget) => void,
    admitsNewJoin?: (target: RouteTarget) => boolean
  ): ConversationTarget[] {
    const a = this.bots.get(botId)
    if (!a || a.mutedChannels?.includes(msg.channel)) return []
    const key = sessionKeyOf(msg)
    const byConversation = this.participants.get(botId) ?? new Map<string, Map<string, RouteTarget>>()
    const remembered = byConversation.get(key) ?? new Map<string, RouteTarget>()

    const explicitIds = new Set<string>()
    const namesBot = a.botUserId !== undefined && msg.mentionedBots.includes(a.botUserId)
    if (namesBot) {
      for (const route of a.routes) {
        if (route.match.kind !== 'mention' || !scopeMatches(route, msg)) continue
        if (route.agentId !== verifiedAgentAuthor) explicitIds.add(route.agentId)
      }
      // A human explicitly addressed this bot. Even when channel ownership is an
      // `auto` rule, the compatibility primary is the named target and must receive
      // target-specific mention semantics so it can clear its own `!stop` latch.
      if (verifiedAgentAuthor === undefined && primary) explicitIds.add(primary.agentId)
    }

    const selected = new Map<string, ConversationTarget>()
    const add = (candidate: RouteTarget, via: 'mention' | 'implicit'): void => {
      if (candidate.agentId === verifiedAgentAuthor) return
      const current = this.agentTarget(botId, candidate.agentId, msg.channel)
      if (!current) return
      const previousParticipant = remembered.get(current.agentId)
      // Policy is part of admission, not merely this event's delivery. A denied
      // agent-authored edge must not leave behind local or durable membership that
      // a later human follow-up could activate. Existing legitimate membership is
      // retained; the caller still re-checks policy before each agent-authored copy.
      if (!previousParticipant && admitsNewJoin && !admitsNewJoin(current)) return
      const effectiveVia = verifiedAgentAuthor === undefined && via === 'mention' ? 'mention' : 'implicit'
      const previous = selected.get(current.agentId)
      if (!previous || effectiveVia === 'mention') selected.set(current.agentId, { target: current, via: effectiveVia })
      if (!byConversation.has(key)) {
        if (byConversation.size >= MAX_PARTICIPANT_CONVERSATIONS) byConversation.clear()
        byConversation.set(key, remembered)
        this.participants.set(botId, byConversation)
      }
      remembered.set(current.agentId, current)
      if (
        !previousParticipant ||
        previousParticipant.daemonId !== current.daemonId ||
        previousParticipant.integrationId !== current.integrationId
      ) {
        onJoin?.(current)
      }
    }

    if (primary) add(primary, explicitIds.has(primary.agentId) ? 'mention' : 'implicit')
    for (const route of a.routes) {
      if (explicitIds.has(route.agentId)) add(target(route), 'mention')
      if (route.match.kind === 'auto' && scopeMatches(route, msg)) add(target(route), 'implicit')
    }
    // The verified final carries exact resolved agent ids across provider
    // splitting/echo. They JOIN the room but never replace its existing members,
    // and agent-authored joins remain implicit so they cannot lift a human stop.
    for (const agentId of joinedAgentIds) {
      const joined = this.agentTarget(botId, agentId, msg.channel)
      if (joined) add(joined, 'implicit')
    }
    for (const participant of remembered.values()) add(participant, 'implicit')
    return [...selected.values()]
  }

  /** Every currently-assigned bot (ingest lifecycle reconciliation). */
  all(): BotAssignment[] {
    return [...this.bots.values()]
  }
}

/** Map the CP's `rc/bot-assign` frame to the manager's {@link BotAssignment}
 *  (drop absent optionals so the strict-optional shape holds). Returns null for a
 *  secret bag neither typed shape matches (§6.7 open reader: a platform this build
 *  predates) — the caller logs and skips; the assign handler would refuse the
 *  platform anyway, this just refuses it before touching credentials. */
export function toBotAssignment(a: RcBotAssign): BotAssignment | null {
  const secrets =
    'botToken' in a.secrets && typeof a.secrets.botToken === 'string' && typeof a.secrets.signingSecret === 'string'
      ? { botToken: a.secrets.botToken, signingSecret: a.secrets.signingSecret }
      : 'verificationToken' in a.secrets && typeof a.secrets.verificationToken === 'string'
        ? {
            verificationToken: a.secrets.verificationToken,
            ...(typeof a.secrets.encryptKey === 'string' ? { encryptKey: a.secrets.encryptKey } : {})
          }
        : null
  if (!secrets) return null
  // §6.7: the opaque ingress bag is the ONE carrier of the demux identity. The
  // named top-level twins left the wire schema with the S3 protocol cleanup
  // (emission had already stopped, #556), so there is nothing to fall back to —
  // a non-string slot in the bag reads as absent, and an absent identity means
  // the verify-scan path, exactly as a manual-paste install always demuxed.
  const ingress = (a.ingress ?? {}) as {
    apiAppId?: unknown
    teamId?: unknown
    workspaceId?: unknown
    botUserId?: unknown
  }
  const apiAppId = typeof ingress.apiAppId === 'string' ? ingress.apiAppId : undefined
  const teamId = typeof ingress.teamId === 'string' ? ingress.teamId : undefined
  // An older CP omits it; the fence then reads whatever `teamId` carries, which
  // is exactly today's behaviour (ingress-tenant-fence.md §3.3 fail-open).
  const workspaceId = typeof ingress.workspaceId === 'string' ? ingress.workspaceId : undefined
  const botUserId = typeof ingress.botUserId === 'string' ? ingress.botUserId : undefined
  return {
    botId: a.botId,
    platform: a.platform,
    secrets,
    ...(apiAppId ? { apiAppId } : {}),
    ...(teamId ? { teamId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(a.credentialRevision !== undefined ? { credentialRevision: a.credentialRevision } : {}),
    ...(botUserId ? { botUserId } : {}),
    members: a.members,
    agents: mapAgentDirectory(a.agents),
    routes: a.routes,
    ...(a.defaultAgentId ? { defaultAgentId: a.defaultAgentId } : {}),
    ...(a.defaultDaemonId ? { defaultDaemonId: a.defaultDaemonId } : {}),
    gatedAgentIds: a.gatedAgentIds,
    mutedChannels: a.mutedChannels,
    gatedOffChannels: a.gatedOffChannels,
    noticedDmConversations: a.noticedDmConversations,
    ...(a.noticeAuthority ? { noticeAuthority: a.noticeAuthority } : {})
  }
}
