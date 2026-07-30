import type { NormalizedMessage } from '../messages/normalized.js'
import type { RoutingRule } from './routing-rule.js'

// ─── routeRules: arbitration ladder over the merged (local ∪ CP) rule set ───

const KIND_ORDER = ['mention', 'dm', 'keyword', 'auto'] as const

/**
 * Does a rule's channel scope cover this message? A channel-scoped rule also serves the
 * threads INSIDE that channel: a Discord session keys on the thread's own channel id, so
 * a trigger the operator set on "#general" would otherwise stop applying the moment the
 * bot opens a thread there. Every channel-scope comparison in the ladder goes through
 * here — the scope filter AND the CP-override check — so the two can't disagree.
 */
function channelInScope(scopeChannel: string | undefined, msg: NormalizedMessage): boolean {
  if (scopeChannel === undefined) return true
  return scopeChannel === msg.channel || scopeChannel === msg.parentChannel
}

function scopeMatches(r: RoutingRule, msg: NormalizedMessage): boolean {
  // A platform-tagged rule only serves its own platform, so an unscoped Slack
  // `dm`/`auto` rule can't route a Telegram message (and vice-versa). Undefined
  // platform (legacy/tests) matches any.
  if (r.platform !== undefined && r.platform !== msg.platform) return false
  if (!channelInScope(r.scope.channel, msg)) return false
  if (r.scope.thread !== undefined && r.scope.thread !== msg.thread) return false
  return true
}

function kindMatches(r: RoutingRule, msg: NormalizedMessage): boolean {
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

const pickRule = (r: RoutingRule, via: RouteVia) => ({ agentId: r.agentId, integrationId: r.integrationId, via })

/**
 * Arbitrate the merged (local ∪ CP) rule set for an inbound message (design §8.2/§8.3).
 * Ladder: (1) explicit @bot mention (cross-layer; overrides thread affinity) →
 * (2) thread affinity (highest after explicit @; bypasses the kind filter, gated on
 * reachable-bot count) → (3) CP per-sessionKey override → (4/5) kind precedence
 * mention > dm > keyword > auto within the chosen layer.
 *
 * `explicitAgentId` short-circuits the whole ladder: a relay webchat turn names its
 * target agent in the `rd/msg` payload, so there is nothing to arbitrate — it routes
 * directly to that agent (integrationId '' because webchat ingress arrives over the
 * relay data plane rather than a platform integration). Null if that agentId isn't a
 * servable rule here.
 */
export function routeRules(
  msg: NormalizedMessage,
  rules: RoutingRule[],
  threadOwner: (channel: string, thread: string) => string | null,
  explicitAgentId?: string
): { agentId: string; integrationId: string; via: RouteVia } | null {
  if (explicitAgentId !== undefined) {
    // Direct address (webchat): the message names its agent, so bypass mention/thread/
    // keyword/auto arbitration entirely. No Slack integration is involved.
    return { agentId: explicitAgentId, integrationId: '', via: 'mention' }
  }
  const authz = (r: RoutingRule) =>
    !r.allowedUserIds || r.allowedUserIds.length === 0 || r.allowedUserIds.includes(msg.sender.id)

  // scope-candidates: scope + authz, KIND-AGNOSTIC (used for reachability + thread continuity).
  const scopeCandidates = rules.filter((r) => scopeMatches(r, msg) && authz(r))
  // kind-candidates: also match the message kind.
  const kindCandidates = scopeCandidates.filter((r) => kindMatches(r, msg))

  // 1. explicit @bot mention — across layers; overrides thread affinity (§8.3).
  const mention = kindCandidates.find((r) => r.match.kind === 'mention')
  // A third-party Slack bot may explicitly address an agent. Bot-authored traffic
  // never falls through to DM/thread/keyword/auto; AgentConnect-managed bot apps are
  // removed by the daemon before this pure routing boundary.
  if (mention && (!msg.sender.isBot || msg.platform === 'slack')) return pickRule(mention, 'mention')
  if (msg.sender.isBot) return null
  // An unmatched mention in a channel belongs to another bot (or a human). Do not let
  // local thread affinity claim it: dedicated Slack apps each see the channel event,
  // and every daemon otherwise believes its own agent is the sole local thread owner.
  // A one-to-one DM is already addressed to this bot, though, so mentioning the bot (or
  // another participant) must not suppress its dm rule. Group DMs are channel-like and
  // normalize with isDm=false, so they remain mention-gated here.
  if (!msg.isDm && msg.mentionedBots.length > 0) return null

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
