/**
 * Slack mention ADDRESSES for AgentConnect agents (send-message-routing-rework.md
 * §2.1 / §5 / §6 / §8.5).
 *
 * §2.1 makes an ordinary reply carrying a platform-native mention THE way an agent
 * addresses a peer or a human in its current thread. That makes the mapping between a
 * `<@…>` token and an agent load-bearing in both directions:
 *
 *  - RENDER — build the exact token to put in a body (a channel-root `toAgent` post,
 *    §3.2; the `mention` field on a channel-filtered `listAgents`, §8.5), so the model
 *    never has to guess an address from a display name.
 *  - RESOLVE — turn the mentions in a finalized response back into the recipient agent
 *    set (§5.1), and turn an inbound mention into the target of a routing edge (§6).
 *
 * Both directions live here, in ONE pure module shared by the daemon and the relay,
 * because a disagreement between them is a routing bug: the daemon would stamp a
 * recipient set the relay refuses to honor, or vice versa.
 *
 * The shared-bot case is what makes this more than a regex. A shared Slack app posts
 * as ONE bot user for MANY agents, so `<@U_SHARED>` alone identifies the app, not an
 * agent. Its address therefore carries the agent slug — `<@U_SHARED> reviewer` — and a
 * BARE shared-bot mention resolves to NOTHING. That is deliberate: §6 requires that a
 * bare shared-bot mention from an agent must not fall back to the channel's default
 * agent, and §4 requires a shared bot with no exact author claim to fail closed.
 */

/** The public identity inputs one agent contributes, straight from the collaboration
 *  snapshot's channel-scoped placement (`botUserId` / `botShared` / `name`). No
 *  credential is involved — a bot user id is public metadata. */
export interface AgentMentionIdentity {
  agentId: string
  /** Slack member id this agent's bot posts as (`U…`/`B…`). Absent ⇒ the agent has no
   *  Slack presence in this conversation and therefore no address. */
  botUserId?: string
  /** True when `botUserId` backs more than one agent, so the address needs the slug. */
  botShared?: boolean
  /** Directory slug used to disambiguate agents behind a shared bot. */
  name?: string
}

/** `<@U123>` / `<@U123|label>` — Slack's user/bot mention encoding. The optional
 *  `|label` is display sugar Slack itself inserts; it never changes the addressee. */
const MENTION_RE = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g

/** The slug immediately following a shared-bot mention. Bounded to Slack-safe slug
 *  characters so ordinary prose after a bare mention ("<@U_SHARED> please check") can
 *  only match an agent that is genuinely named `please`. */
const TRAILING_SLUG_RE = /^[ \t]*([A-Za-z0-9._-]+)/

/**
 * The exact platform-native address for `agent` in the conversation this identity came
 * from, or undefined when the agent has no Slack presence there (nothing to address).
 *
 * A shared bot's address is two tokens by necessity; callers that split a message must
 * treat the whole string as indivisible (see the daemon's `splitIntoSections`).
 */
export function slackMentionAddress(agent: AgentMentionIdentity): string | undefined {
  if (!agent.botUserId) return undefined
  if (!agent.botShared) return `<@${agent.botUserId}>`
  // A shared bot with no slug cannot be addressed unambiguously — and inventing a bare
  // mention would silently address the app instead of this agent.
  return agent.name ? `<@${agent.botUserId}> ${agent.name}` : undefined
}

/**
 * Every agent EXACTLY addressed by `text`, in first-appearance order, deduplicated.
 *
 * "Exactly" is the whole contract: an unresolvable mention contributes nothing rather
 * than falling back to a default or a fuzzy name match. A bare shared-bot mention is
 * the canonical example — it names an app that stands for several agents, so it
 * resolves to none of them (§6).
 *
 * `agents` is the conversation-specific directory. Passing an org-wide list would be a
 * bug: the same slug can belong to different agents in different conversations.
 */
export function resolveSlackMentionedAgents(text: string, agents: readonly AgentMentionIdentity[]): string[] {
  if (!text) return []
  // botUserId → the agents behind it. A dedicated bot has exactly one; a shared bot has
  // many, and they are told apart by the slug that follows the mention.
  const byUserId = new Map<string, AgentMentionIdentity[]>()
  for (const agent of agents) {
    if (!agent.botUserId) continue
    const bucket = byUserId.get(agent.botUserId)
    if (bucket) bucket.push(agent)
    else byUserId.set(agent.botUserId, [agent])
  }
  const resolved: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(MENTION_RE)) {
    const candidates = byUserId.get(match[1]!)
    if (!candidates) continue
    // Sharing is a property of this complete conversation directory. Do not trust a
    // stale `botShared` flag derived from bot configuration: one candidate is dedicated
    // here; several candidates require the trailing agent slug.
    const shared = candidates.length > 1
    let agent: AgentMentionIdentity | undefined
    if (!shared) {
      agent = candidates[0]
    } else {
      const slug = TRAILING_SLUG_RE.exec(text.slice(match.index + match[0].length))?.[1]?.toLowerCase()
      // No slug, or a slug naming nobody here ⇒ this mention addresses no agent.
      agent = slug ? candidates.find((c) => c.name?.toLowerCase() === slug) : undefined
    }
    if (agent && !seen.has(agent.agentId)) {
      seen.add(agent.agentId)
      resolved.push(agent.agentId)
    }
  }
  return resolved
}
