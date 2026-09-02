/**
 * The PURE activation policy — "who does this message activate" — shared by every surface so
 * the ladders cannot drift apart by hand. Design and the per-ladder divergences:
 * docs/designs/activation-parity.md and send-message-routing-rework.md §6/§2.3.
 *
 * Constraint: NO I/O, no daemon imports, no platform SDKs. Callers supply message facts, resolved
 * rules, context as plain values/callbacks, and already-VERIFIED authorship (verification needs
 * I/O, so it stays with the caller).
 *
 * Pinned divergence, deliberately not harmonized: the daemon ladder admits bot-sender mentions via
 * a Slack literal while the relay ladder reads the manifest's `botSenderRouting`. Both are
 * Slack-only today, so behavior is identical — but a platform that admits bot senders must revisit
 * {@link routeRules} alongside the manifest.
 */
import { MAX_AGENT_CALL_HOPS, hasReachedAgentCallHopLimit, manifestFor } from '@agentconnect.md/protocol'

/** A routing rule's trigger — structurally identical to the daemon's
 *  `BindMatch` (agent.json bindRules) and the wire route match. */
export type RuleMatch = { kind: 'mention' } | { kind: 'dm' } | { kind: 'keyword'; value: string } | { kind: 'auto' }

/**
 * One resolved routing rule of the merged (local ∪ CP) set. Structurally
 * satisfied by the daemon's `RoutingRule` (router/routing-rule.ts), which
 * remains the documented owner of how these are BUILT from integrations and
 * CP frames — building rules needs config/wire knowledge this package must
 * not have.
 */
export interface ActivationRule {
  agentId: string
  integrationId: string
  botUserId: string // for `mention` matching ("" when unknown)
  scope: { channel?: string; thread?: string }
  match: RuleMatch
  /** Channels its integration is switched OFF in — the subtractive fence a
   *  purely additive rule set cannot express. Carried per rule so the ladder
   *  stays pure and every rung is fenced by the one scope filter. */
  mutedChannels?: string[]
  source: 'config' | 'cp'
  epoch?: number // cp layer only
  /** Platform this rule belongs to. Undefined = matches any platform
   *  (legacy/tests); rules built from integrations always set it. */
  platform?: string
}

/** The message facts the policy reads — a structural subset of the daemon's
 *  `NormalizedMessage`, so callers pass their message object directly. */
export interface ActivationMessageFacts {
  platform: string
  channel: string
  thread?: string | undefined
  text: string
  isDm: boolean
  mentionedBots: string[]
  sender: { isBot: boolean }
}

// ─── routeRules: arbitration ladder over the merged (local ∪ CP) rule set ───

const KIND_ORDER = ['mention', 'dm', 'keyword', 'auto'] as const

function channelInScope(scopeChannel: string | undefined, msg: ActivationMessageFacts): boolean {
  if (scopeChannel === undefined) return true
  return scopeChannel === msg.channel
}

function scopeMatches(r: ActivationRule, msg: ActivationMessageFacts): boolean {
  // A platform-tagged rule only serves its own platform, so an unscoped Slack
  // `dm`/`auto` rule can't route a Telegram message (and vice-versa). Undefined
  // platform (legacy/tests) matches any.
  if (r.platform !== undefined && r.platform !== msg.platform) return false
  // A channel the operator switched OFF silences its integration outright. Applied
  // here, in the ONE scope filter, so no rung can slip past it: not an unscoped
  // mention default, not thread continuity (which reads the same candidate set), not
  // a CP session placement. Threads inherit the enclosing channel's Off through the
  // same predicate the positive scope uses.
  if (r.mutedChannels?.some((muted) => channelInScope(muted, msg))) return false
  if (!channelInScope(r.scope.channel, msg)) return false
  if (r.scope.thread !== undefined && r.scope.thread !== msg.thread) return false
  return true
}

function kindMatches(r: ActivationRule, msg: ActivationMessageFacts): boolean {
  switch (r.match.kind) {
    case 'mention':
      return r.botUserId !== '' && msg.mentionedBots.includes(r.botUserId)
    case 'dm':
      return msg.isDm
    case 'keyword':
      return msg.text.toLowerCase().includes(r.match.value.toLowerCase())
    case 'auto':
      return true
  }
}

/** Which ladder rung matched. `mention` is the only *explicit address* — the daemon
 *  uses it to clear (and bypass) a `!stop` thread mute; everything else is implicit
 *  routing and is suppressed while the session is muted. */
export type RouteVia = 'mention' | 'thread' | 'dm' | 'keyword' | 'auto'

const pickRule = (r: ActivationRule, via: RouteVia) => ({ agentId: r.agentId, integrationId: r.integrationId, via })

/** Every agent this connection serves that the message's mentions actually NAME. A mention is a
 *  JOIN, and a body can name several agents — so this returns the whole set, and nothing depends
 *  on which rule `find` saw first (the shape that made a shared bot resolve one event two ways). */
export function mentionedAgents(msg: ActivationMessageFacts, rules: ActivationRule[], exclude?: string): string[] {
  if (msg.mentionedBots.length === 0) return []
  const named = new Set<string>()
  for (const r of rules) {
    if (r.match.kind !== 'mention' || !scopeMatches(r, msg)) continue
    if (r.botUserId === '' || !msg.mentionedBots.includes(r.botUserId)) continue
    if (r.agentId !== exclude) named.add(r.agentId)
  }
  return [...named]
}

/** Agents this connection serves that are ALREADY in the thread, minus `exclude`. Scope
 *  (including the Off fence) is applied here so a participant in a silenced channel is
 *  not revived by conversation it can no longer take part in. */
export function participantAgents(
  msg: ActivationMessageFacts,
  rules: ActivationRule[],
  participants: readonly string[],
  exclude?: string
): string[] {
  if (participants.length === 0) return []
  const servable = new Set(rules.filter((r) => scopeMatches(r, msg)).map((r) => r.agentId))
  return participants.filter((id) => id !== exclude && servable.has(id))
}

/** Agents whose `auto` rule makes them participants in every conversation covered by
 * that rule. Unlike `routeRules`, this returns the whole set: channel-wide participation
 * is not an arbitration tie that should collapse to whichever rule happens to be first. */
export function automaticAgents(msg: ActivationMessageFacts, rules: ActivationRule[], exclude?: string): string[] {
  return [
    ...new Set(
      rules
        .filter((r) => r.match.kind === 'auto' && scopeMatches(r, msg) && r.agentId !== exclude)
        .map((r) => r.agentId)
    )
  ]
}

/**
 * Arbitrate the merged (local ∪ CP) rule set for an inbound message (design §8.2/§8.3).
 * Ladder: explicit @bot mention → thread affinity → CP per-sessionKey override → kind
 * precedence mention > dm > keyword > auto.
 *
 * `explicitAgentId` short-circuits the ladder (webchat names its target). `verifiedAgentAuthor`
 * opens the implicit rungs to an AgentConnect-authored message (§2.3) with the author removed so
 * it can never wake itself — set it ONLY after authorship is verified; unverified bots, including
 * third-party ones, still stop at the explicit-mention rung.
 */
export function routeRules(
  msg: ActivationMessageFacts,
  rules: ActivationRule[],
  threadOwner: (channel: string, thread: string) => string | null,
  explicitAgentId?: string,
  verifiedAgentAuthor?: string
): { agentId: string; integrationId: string; via: RouteVia } | null {
  if (explicitAgentId !== undefined) {
    // Webchat names its agent; integrationId '' because ingress is the relay data plane.
    return { agentId: explicitAgentId, integrationId: '', via: 'mention' }
  }
  // Kind-agnostic (reachability + thread continuity). The author is removed HERE, once, so every
  // rung below inherits it: an agent matching its own rule would self-loop on its own reply.
  const scopeCandidates = rules.filter(
    (r) => scopeMatches(r, msg) && (verifiedAgentAuthor === undefined || r.agentId !== verifiedAgentAuthor)
  )
  // kind-candidates: also match the message kind.
  const kindCandidates = scopeCandidates.filter((r) => kindMatches(r, msg))

  // 1. explicit @bot mention — across layers; overrides thread affinity (§8.3).
  const mention = kindCandidates.find((r) => r.match.kind === 'mention')
  if (mention && verifiedAgentAuthor === undefined && (!msg.sender.isBot || msg.platform === 'slack')) {
    return pickRule(mention, 'mention')
  }
  // Only a VERIFIED AgentConnect author continues into the implicit rungs (§2.3); every other bot
  // stops here rather than falling through to dm/thread/keyword/auto.
  if (msg.sender.isBot && verifiedAgentAuthor === undefined) return null
  // An unmatched channel mention belongs to someone else, so thread affinity must not claim it —
  // otherwise every daemon believes its own agent owns the thread. A 1:1 DM is already addressed
  // to this bot (group DMs normalize isDm=false and stay mention-gated). A verified author is
  // exempt: a `<@…>` aimed at anyone must not silence its peers.
  if (!msg.isDm && msg.mentionedBots.length > 0 && verifiedAgentAuthor === undefined) return null

  // 2. thread affinity (§8.2 step 2 — highest after explicit @; bypasses kind filter).
  if (msg.thread) {
    const owner = threadOwner(msg.channel, msg.thread)
    if (owner) {
      // threadOwner returns the sole agent with an OPEN session in this thread, and
      // null when 2+ agents actively share it (→ mention-gated via fallthrough). Thread
      // PARTICIPATION, not channel reachability, is the disambiguator (§8.5): route an
      // un-mentioned follow-up to that owner if it's reachable here, regardless of how
      // many other bots are also bound to the channel.
      const ownerRule = scopeCandidates.find((x) => x.agentId === owner)
      if (ownerRule) return pickRule(ownerRule, 'thread') // continuity, kind-agnostic
    }
  }

  // 3. CP per-sessionKey override (§8.3: CP authoritative).
  // A rule scoped to the channel this message sits in (its enclosing channel counts —
  // same predicate as the scope filter), NOT an unscoped global CP rule.
  const cpInChannel = kindCandidates.some(
    (r) =>
      r.source === 'cp' &&
      r.scope.channel !== undefined &&
      channelInScope(r.scope.channel, msg) &&
      (r.scope.thread === undefined || r.scope.thread === msg.thread)
  )
  const layer = cpInChannel ? kindCandidates.filter((r) => r.source === 'cp') : kindCandidates

  // 4/5. kind precedence within the chosen layer (mention already handled).
  for (const kind of KIND_ORDER) {
    if (kind === 'mention') continue
    const r = layer.find((x) => x.match.kind === kind)
    if (r) return pickRule(r, kind)
  }
  return null
}

// ─── conversation-delivery selection and verified-agent edge gates ───

/**
 * Does this conversation admit an activation for `agentId` at all?
 *
 * The per-channel trigger is an operator fence, not a routing preference: "Off means the
 * agent does not respond in that channel at all. Not to an @-mention, not to a follow-up
 * in a thread it had already joined, not to a control command" (product-conventions).
 * The human ladder gets this from `routeRules`' scope filter, which the verified-agent
 * ladder deliberately bypasses — so the fence is re-applied through this predicate
 * rather than inherited.
 *
 * Implemented as "some rule for this agent covers this channel and none mutes it",
 * which is the same data `routeRules` consults, minus the kind/trigger matching that
 * would be wrong here (an agent mention is explicit by construction).
 */
export function conversationAdmitsAgent(rules: readonly ActivationRule[], agentId: string, channel: string): boolean {
  const agentRules = rules.filter((rule) => rule.agentId === agentId)
  if (agentRules.length === 0) return false
  const covers = (scopeChannel: string | undefined): boolean => scopeChannel === undefined || scopeChannel === channel
  if (agentRules.some((rule) => rule.mutedChannels?.some((muted) => covers(muted)))) return false
  return agentRules.some((rule) => covers(rule.scope.channel))
}

/** Is a stamped source depth usable at all? §4.1 rule 1 / §5.2a fail-closed: a
 *  missing, non-integer, or negative depth must never coerce to zero — the
 *  message stays transcript-only instead. */
export function isUsableSourceDepth(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 0
}

/**
 * The §4.1 trusted hop transition: ONE +1 per agent-to-agent delivery, against
 * the SAME `MAX_AGENT_CALL_HOPS` cap an internal call spends — so a mention
 * chain, a `messageAgent` chain, and a webchat continuation all consume the
 * one budget at the same rate. `refusal` is set when the edge must not run;
 * the caller records the message transcript-only and logs the refusal.
 */
export function hopTransition(sourceHopCount: number): {
  deliveryHopCount: number
  refusal?: { reason: 'hop_limit'; cap: number }
} {
  const deliveryHopCount = sourceHopCount + 1
  if (hasReachedAgentCallHopLimit(deliveryHopCount)) {
    return { deliveryHopCount, refusal: { reason: 'hop_limit', cap: MAX_AGENT_CALL_HOPS } }
  }
  return { deliveryHopCount }
}

/**
 * Everyone a conversation event is DELIVERED to beyond the arbitration
 * primary (send-message-routing-rework.md §2.3/§6): agents already in the
 * thread, every agent the body explicitly names, the verified final's exact
 * recipient joins, and channel-`auto` agents — author and primary excluded.
 *
 * Pure selection only: each returned peer is still an INDEPENDENT delivery
 * whose edge gates (call policy, Off fence, `!stop` mute, hop budget,
 * exactly-once rendezvous) the caller applies per target. Insertion order is
 * part of the contract — participants, then explicit joins, then automatic —
 * because callers dispatch in iteration order.
 */
export function conversationPeers(
  msg: ActivationMessageFacts,
  rules: ActivationRule[],
  /** Agents with an open session in this thread (the caller's session state). */
  participants: readonly string[],
  options: {
    /** The arbitration primary, excluded from the peer set. */
    primaryAgentId?: string | undefined
    /** Verified agent authorship: the author is excluded absolutely, and the
     *  final's exact resolved recipients JOIN even where provider bot-user
     *  metadata alone cannot map the mention back to an agent. */
    verified?: { authorAgentId: string; recipients: readonly string[] } | undefined
  } = {}
): { peers: string[]; explicitlyMentioned: ReadonlySet<string> } {
  const explicitlyMentioned = new Set(mentionedAgents(msg, rules, options.primaryAgentId))
  // A verified final carries the exact agent ids resolved before provider
  // splitting/echo. They are joins, not the complete delivery set: include them
  // so a shared-bot peer with an unscoped slug route can enter the room even when
  // provider bot-user metadata alone cannot map the mention back to that agent.
  if (options.verified) {
    for (const agentId of options.verified.recipients) {
      if (agentId !== options.primaryAgentId && agentId !== options.verified.authorAgentId) {
        explicitlyMentioned.add(agentId)
      }
    }
  }
  const peers = new Set([
    ...participantAgents(msg, rules, participants, options.primaryAgentId),
    ...explicitlyMentioned,
    ...automaticAgents(msg, rules, options.primaryAgentId)
  ])
  if (options.primaryAgentId !== undefined) peers.delete(options.primaryAgentId)
  if (options.verified) peers.delete(options.verified.authorAgentId)
  return { peers: [...peers], explicitlyMentioned }
}

// ─── webchat: roster targeting and the §5.2a continuation edge ───

/**
 * Which participants one webchat USER turn activates (the human-kickoff
 * choice; webchat-multi-agents.md §4.2, parity scenario
 * `human-kickoff-activation`).
 *
 * Conversation membership is a STANDING mention: an unmentioned message
 * activates the WHOLE roster — each agent may still decline via the
 * no-response contract — while explicit @mentions (or an explicit `targets`
 * list) narrow the turn to the named participants. This is the DECLARED
 * divergence from mention-gated channels (evals/parity/spec.ts): pulling
 * agents into a conversation is equivalent to having @-mentioned them all in
 * its first message.
 *
 * `valid` preserves the chosen list's order filtered to roster members;
 * `invalid` are the chosen non-members (the relay nacks each
 * `not_participant`). Roster members outside `valid` receive the turn as a
 * transcript-only `context` copy instead.
 */
export function selectTurnTargets(
  roster: readonly string[],
  options: { mentions?: readonly string[]; requestedTargets?: readonly string[] } = {}
): { valid: string[]; invalid: string[] } {
  const chosen = options.requestedTargets?.length
    ? options.requestedTargets
    : options.mentions?.length
      ? options.mentions
      : roster
  const members = new Set(roster)
  return {
    valid: chosen.filter((agentId) => members.has(agentId)),
    invalid: chosen.filter((agentId) => !members.has(agentId))
  }
}

/** The author facts of a committed webchat post — a structural subset of the
 *  wire `WebchatPost['author']`, so callers pass it directly. */
export interface WebchatPostAuthorFacts {
  kind: string
  agentId?: string | undefined
  /** The depth the AUTHOR's daemon stamped on the post (absent on a user post,
   *  a pre-parity daemon's post, or a claim the relay could not bind). */
  hopCount?: number | undefined
}

export type WebchatContinuationDecision =
  | { activate: true; authorAgentId: string; deliveryHopCount: number }
  | { activate: false; reason: 'user_post' | 'self' | 'no_usable_depth' }
  | { activate: false; reason: 'hop_limit'; authorAgentId: string; sourceHopCount: number; cap: number }

/**
 * The webchat analogue of the §6 verified-agent continuation ladder (#549
 * parity — webchat-multi-agents.md §5.2a, issue #904), as a pure decision:
 * does a peer agent's COMMITTED conversation post, fanned to this
 * pre-addressed participant as a `context` frame, wake it — or stay
 * transcript-only? The relay's roster fan-out already excluded the author and
 * chose the targets, so no arbitration happens here — only the checks the
 * platform ladder applies to an implicitly selected edge:
 *
 *  - user turns activate through the relay's pre-addressed `turn` frames;
 *    their context copies never activate (`user_post`);
 *  - author exclusion is absolute (`self` — the fail-safe re-check; the relay
 *    already skips the author);
 *  - a post with no usable stamped depth must never coerce to zero
 *    (`no_usable_depth` — §4.1 rule 1 / §5.2a fail-closed);
 *  - the §4.1 hop transition: ONE +1 against the SAME `MAX_AGENT_CALL_HOPS`
 *    budget an internal call spends (`hop_limit` when the edge must not run).
 *
 * The caller still owns everything impure about the edge: the directional
 * call policy, the exactly-once activation rendezvous, agent
 * liveness/draining, logging, and dispatch — and deliberately does NOT charge
 * the coarse loop guard (webchat has no in-band `!resume` surface).
 */
export function webchatContinuationDecision(
  author: WebchatPostAuthorFacts,
  targetAgentId: string
): WebchatContinuationDecision {
  if (author.kind !== 'agent' || author.agentId === undefined) return { activate: false, reason: 'user_post' }
  if (author.agentId === targetAgentId) return { activate: false, reason: 'self' }
  if (!isUsableSourceDepth(author.hopCount)) return { activate: false, reason: 'no_usable_depth' }
  const transition = hopTransition(author.hopCount)
  if (transition.refusal) {
    return {
      activate: false,
      reason: 'hop_limit',
      authorAgentId: author.agentId,
      sourceHopCount: author.hopCount,
      cap: transition.refusal.cap
    }
  }
  return { activate: true, authorAgentId: author.agentId, deliveryHopCount: transition.deliveryHopCount }
}

// ─── the shared-bot relay ladder (shared-bot-relay.md §10) ───

/**
 * The message facts the shared-bot ladder reads — {@link ActivationMessageFacts}
 * plus the sender's provider id (own-echo suppression) and the group-DM bit
 * (direct-control continuity). `WireNormalizedMessage` satisfies it.
 */
export interface SharedBotMessageFacts extends ActivationMessageFacts {
  sender: { id: string; isBot: boolean }
  isGroupDm?: boolean | undefined
}

/** One attributed routing rule the relay arbitrates inbound against —
 *  structurally a subset of the wire `AttributedRoute` (it ALREADY carries its
 *  target: the daemon to forward to and the reply integration). */
export interface SharedBotRoute {
  agentId: string
  daemonId: string
  integrationId: string
  scope?: { channel?: string | undefined; thread?: string | undefined } | undefined
  match: RuleMatch
}

/** The arbitration verdict — a target the relay forwards to. */
export interface SharedBotRouteTarget {
  agentId: string
  daemonId: string
  integrationId: string
}

/** The assignment facts the ladder reads — a structural subset of the relay's
 *  `BotAssignment` (secrets, demux identity, and notice bookkeeping stay with
 *  the relay). */
export interface SharedBotAssignmentFacts {
  /** Provider bot identity — used for mention + echo suppression. */
  botUserId?: string | undefined
  routes: SharedBotRoute[]
  members: { daemonId: string; agentIds: string[] }[]
  defaultAgentId?: string | undefined
  defaultDaemonId?: string | undefined
  /** Conversation-gated members (resource-visibility.md §14): thread continuity
   *  to one of these agents is honoured only while it still has a
   *  channel-scoped route in the conversation. */
  gatedAgentIds?: string[] | undefined
  /** Channels switched OFF — a fence rather than an omission: rungs exist that
   *  no missing route can suppress (continuity, the unscoped keyword slug,
   *  `defaultAgentId`), so a muted channel resolves to nothing. */
  mutedChannels?: string[] | undefined
  /** Per-conversation defaults (linear-integration.md §6.2): a channel's own
   *  default agent, consulted after keyword and thread continuity and before the
   *  group's `defaultAgentId`. Also the grant a gated agent holds on such a
   *  platform — the affinity gate honours a binding while its agent is the
   *  channel's default. Empty ⇒ the ladder behaves exactly as before. */
  conversationDefaults?: readonly SharedBotConversationDefault[] | undefined
  /** True where a conversation row's owner compiles to the default rung above
   *  rather than to a channel-scoped ownership route. On such an assignment a
   *  gated binding the affinity gate rejects is TERMINAL (`grant-withdrawn`),
   *  never a miss that falls through to the channel's new default. */
  ownerAsDefault?: boolean | undefined
}

/** One channel's default agent — already attributed, like a route. */
export interface SharedBotConversationDefault {
  channel: string
  agentId: string
  daemonId: string
  integrationId: string
}

/** The ladder's verdict. `refused` is terminal: the caller drops the delivery
 *  instead of continuing down the ladder or re-arbitrating (§6.2). */
export type SharedBotArbitration =
  { kind: 'target'; target: SharedBotRouteTarget } | { kind: 'refused'; reason: 'grant-withdrawn' } | { kind: 'none' }

/** `channel/thread` — the per-conversation affinity + rc/assign key. */
export function sharedBotSessionKey(msg: { channel: string; thread?: string | undefined }): string {
  return `${msg.channel}/${msg.thread ?? msg.channel}`
}

/** Scope filter over attributed routes (exported for the relay's peer fan-out,
 *  which reads the same routes for its mention/auto join selection). */
export function sharedBotScopeMatches(r: SharedBotRoute, msg: SharedBotMessageFacts): boolean {
  if (r.scope?.channel !== undefined && r.scope.channel !== msg.channel) return false
  if (r.scope?.thread !== undefined && r.scope.thread !== msg.thread) return false
  return true
}

function sharedBotKindMatches(r: SharedBotRoute, msg: SharedBotMessageFacts, botUserId: string | undefined): boolean {
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

const sharedBotTarget = (r: SharedBotRoute): SharedBotRouteTarget => ({
  agentId: r.agentId,
  daemonId: r.daemonId,
  integrationId: r.integrationId
})

/**
 * Arbitrate one inbound message against a shared bot's attributed routes
 * (shared-bot-relay.md §10) — the relay's ladder, package-owned since the
 * relay fold-in. It mirrors the daemon ladder (`routeRules`) but over
 * ALREADY-ATTRIBUTED routes, and adapted for the multi-agent ambiguity (all
 * agents answer as one bot user id) — the adaptations are DECLARED ladder
 * structure, not drift:
 *
 *  - channel ownership first (§10.1): a channel-scoped rule matching the
 *    message kind wins outright, with scoped keyword OUTRANKING scoped auto
 *    (slug disambiguation inside a multi-agent DM, §14.3) and no `dm` rung;
 *  - thread continuity from the caller's affinity map, membership- and
 *    gate-checked (§14), never through a binding that points at the author;
 *  - there is NO unscoped mention rung (it would starve keyword
 *    disambiguation, §10.4) — the bare @bot / DM fallback is the unscoped
 *    keyword slug (§10.2), then the CHANNEL's own default
 *    (`conversationDefaults`, linear-integration.md §6.2), then the group's
 *    `defaultAgentId` (§10.3), all gated on the bot actually being ADDRESSED;
 *  - bot senders are admitted by the platform manifest's `botSenderRouting`
 *    (equivalent today to the daemon ladder's Slack-only admission), and only
 *    through an explicit mention;
 *  - `verifiedAgentAuthor` routes through the ladder exactly as a human would
 *    with itself excluded (send-message-routing-rework.md §2.3), and cannot
 *    use the human-only mention nomination or the default-agent fallback.
 *
 * Pure: the caller owns the affinity map, refreshes it after each routed turn,
 * and seeds it durably from `rc/assign`.
 */
export function arbitrateSharedBot(
  a: SharedBotAssignmentFacts,
  msg: SharedBotMessageFacts,
  affinity: ReadonlyMap<string, SharedBotRouteTarget>,
  verifiedAgentAuthor?: string
): SharedBotRouteTarget | null {
  const result = arbitrateSharedBotResult(a, msg, affinity, verifiedAgentAuthor)
  return result.kind === 'target' ? result.target : null
}

/** {@link arbitrateSharedBot} with the terminal `grant-withdrawn` refusal kept
 *  distinguishable from an ordinary miss — the shape a caller needs to drop a
 *  delivery rather than let the next rung answer it (§6.2). */
export function arbitrateSharedBotResult(
  a: SharedBotAssignmentFacts,
  msg: SharedBotMessageFacts,
  affinity: ReadonlyMap<string, SharedBotRouteTarget>,
  verifiedAgentAuthor?: string
): SharedBotArbitration {
  const hit = (target: SharedBotRouteTarget): SharedBotArbitration => ({ kind: 'target', target })
  const none: SharedBotArbitration = { kind: 'none' }
  // Own echoes never route. A third-party bot may enter only through an explicit
  // mention, and only on a platform whose manifest admits bot senders at all
  // (§5 botSenderRouting — fail-closed for unknown ids); AgentConnect-managed app
  // messages are removed by the manager using the collaboration snapshot before
  // forwarding.
  if (a.botUserId !== undefined && msg.sender.id === a.botUserId && verifiedAgentAuthor === undefined) return none
  const explicitlyMentioned = a.botUserId !== undefined && msg.mentionedBots.includes(a.botUserId)
  if (
    msg.sender.isBot &&
    verifiedAgentAuthor === undefined &&
    (!manifestFor(msg.platform).botSenderRouting || !explicitlyMentioned)
  ) {
    return none
  }
  // A channel switched Off resolves to no target at all — ahead of every rung, so
  // neither an @-mention nor an existing thread binding can reach into it.
  if (a.mutedChannels?.includes(msg.channel)) return none

  // The author is removed ONCE, so every rung below inherits the exclusion — an agent
  // matching its own route would wake itself on its own reply, an unconditional self-loop.
  const routes =
    verifiedAgentAuthor === undefined ? a.routes : a.routes.filter((r) => r.agentId !== verifiedAgentAuthor)
  const scoped = routes.filter((r) => r.scope?.channel !== undefined && sharedBotScopeMatches(r, msg))

  // 1. Channel ownership (§10.1, the primary path): a channel-scoped rule that
  //    matches the message kind wins outright (mention rule needs the @bot; auto
  //    rule fires on any message — the operator's trigger choice).
  // A HUMAN mention can still nominate the compatibility primary. The peer fan-out
  // independently joins every matching route and fans to the remembered room, including
  // peers on other daemons. Verified agent traffic skips this selector: its mention can
  // add a participant but never narrows the room or clears a human's stop latch.
  const ownedMention =
    verifiedAgentAuthor === undefined
      ? scoped.find((r) => r.match.kind === 'mention' && sharedBotKindMatches(r, msg, a.botUserId))
      : undefined
  if (ownedMention) return hit(sharedBotTarget(ownedMention))
  // Conversation-scoped keyword (§14.3): slug disambiguation inside a multi-agent DM
  // enabled for several gated agents — outranks the scoped auto so "<slug> …"
  // names its agent; an unslugged message falls through to the first auto route.
  const ownedKeyword = scoped.find((r) => r.match.kind === 'keyword' && sharedBotKindMatches(r, msg, a.botUserId))
  if (ownedKeyword) return hit(sharedBotTarget(ownedKeyword))
  const ownedAuto = scoped.find((r) => r.match.kind === 'auto')
  if (ownedAuto) return hit(sharedBotTarget(ownedAuto))

  // This channel's own default (linear-integration.md §6.2) — read here for the gate
  // below, applied as a rung further down. On an `ownerAsDefault` platform it is also
  // the only grant a gated agent can hold, the fact the scoped route carries on Slack.
  const channelDefault = a.conversationDefaults?.find((d) => d.channel === msg.channel)

  // 2. Thread continuity: an un-mentioned follow-up in a thread the relay already
  //    routed continues to that agent, provided it is still a member — and, for a
  //    conversation-gated agent (§14), provided the conversation is still enabled
  //    (a channel-scoped route for that agent exists). The affinity map is not
  //    scope-filtered, so without this check a pre-gate binding routes forever.
  // A continuity binding pointing at the author is skipped for the same reason: the
  // thread's remembered owner may BE the agent that just spoke.
  const remembered = affinity.get(sharedBotSessionKey(msg))
  const cont = remembered && remembered.agentId === verifiedAgentAuthor ? undefined : remembered
  const directControlOk =
    !cont || (!msg.isDm && msg.isGroupDm !== true) || scoped.some((r) => r.agentId === cont.agentId)
  // The gate reads the SAME fact from both carriers: on Slack a gated agent's grant is
  // its channel-scoped route, on an `ownerAsDefault` platform it is the default seat.
  const contGrantOk =
    !cont ||
    !a.gatedAgentIds?.includes(cont.agentId) ||
    scoped.some((r) => r.agentId === cont.agentId) ||
    channelDefault?.agentId === cont.agentId
  // Terminal, not a miss: a Linear AgentSession has one writer (§4.6), so letting the
  // channel's new default answer inside a session another runtime still holds would put
  // two daemons on one feed. Slack, with no such axis, keeps its fall-through.
  if (cont && directControlOk && !contGrantOk && a.ownerAsDefault === true) {
    return { kind: 'refused', reason: 'grant-withdrawn' }
  }
  const contGateOk = directControlOk && contGrantOk
  if (cont && contGateOk && a.members.some((m) => m.daemonId === cont.daemonId && m.agentIds.includes(cont.agentId))) {
    if (cont.integrationId) return hit(cont)
    // A CP-projected affinity names no install. Slack backfills from the agent's route; an
    // `ownerAsDefault` platform has no route for its owner, so the seat itself names it — an
    // empty id would reach the daemon as an invalid delivery and be dropped unanswered.
    const route = a.routes.find((r) => r.agentId === cont.agentId)
    if (route) return hit({ ...cont, integrationId: route.integrationId })
    if (channelDefault?.agentId === cont.agentId) return hit({ ...cont, integrationId: channelDefault.integrationId })
    return hit(cont)
  }

  // 3. Keyword disambiguation (§10.2): "@bot <slug> …" → that agent. Only when the
  //    bot was actually addressed (a mention or a DM), so a stray slug substring in
  //    a normal channel message doesn't trigger it.
  const addressed = msg.isDm || (verifiedAgentAuthor === undefined && explicitlyMentioned)
  if (addressed) {
    const kw = routes.find((r) => r.match.kind === 'keyword' && !r.scope && sharedBotKindMatches(r, msg, a.botUserId))
    if (kw) return hit(sharedBotTarget(kw))

    // 4. Per-conversation default (linear-integration.md §6.2): the channel's own row
    //    owner, already attributed. Above the group default and below everything that
    //    names an agent, which is what keeps a mention and a bound session out of it.
    if (channelDefault && channelDefault.agentId !== verifiedAgentAuthor) {
      const member = a.members.some(
        (m) => m.daemonId === channelDefault.daemonId && m.agentIds.includes(channelDefault.agentId)
      )
      if (member) {
        return hit({
          agentId: channelDefault.agentId,
          daemonId: channelDefault.daemonId,
          integrationId: channelDefault.integrationId
        })
      }
    }

    // 5. Default agent (§10.3): a bare @bot / DM with no slug → the group default.
    if (a.defaultAgentId && a.defaultDaemonId && a.defaultAgentId !== verifiedAgentAuthor) {
      // Resolve the default's integrationId from its (keyword) route.
      const def = routes.find((r) => r.agentId === a.defaultAgentId)
      if (def) {
        return hit({ agentId: a.defaultAgentId, daemonId: a.defaultDaemonId, integrationId: def.integrationId })
      }
    }
  }

  return none
}
