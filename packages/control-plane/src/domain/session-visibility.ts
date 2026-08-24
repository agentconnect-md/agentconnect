/**
 * Session-visibility classification (docs/designs/session-visibility.md §4.2).
 *
 * Pure decision function: given what an `event/session` milestone reports plus
 * the ownership lookups the handler already resolved, decide the session's
 * visibility tier and its namespaced owner identity (§2). Zero I/O — the
 * handler performs the lookups, this module only decides, so the whole §4.2
 * table (including every fail-closed path) is unit-testable without a database.
 *
 * Two invariants the rules encode:
 *
 *  - **Fail closed.** A rule that defaults to `private` never widens to `org`
 *    because a lookup failed; an unresolvable owner yields `private` +
 *    `ownerIdentity: null` — a row visible to no one. Distinct from a
 *    stored-but-unmatched platform tuple (a §2 owner-orphan), which identity
 *    linking (§7) lights up retroactively; a null owner has nothing to match
 *    and needs a repair/backfill. A metadata inconsistency must never become
 *    a disclosure.
 *  - **`ownerIdentity` is provenance, not the gate.** It is recorded for every
 *    human-triggered session regardless of tier — for `org` rows it is what
 *    grants its initiator the §4.3 right to pull the session private later.
 */
import type { SessionConversationKind, SessionVisibility, VisibilitySource } from '../persistence/ports.js'

/** Automation `triggeredBy` prefixes (`cron:<id>` / `hook:<id>`) — already
 *  load-bearing in the session list filters. Dream sessions report neither a
 *  platform sender nor a conversation, so they fall through to the same arm. */
const AUTOMATION_TRIGGER_PREFIXES = ['cron:', 'hook:', 'dream:'] as const

/** Everything the classifier needs, with the CP-side lookups already resolved. */
export interface SessionClassificationInput {
  /** Daemon-reported platform echo (`webchat`, `slack`, `hook`, …). */
  platform?: string
  /** Daemon-reported conversation shape (§4.1); absent ⇒ channel behavior. */
  conversationKind?: SessionConversationKind
  /** Durable tenant scope for the IM identity tuple (§2); absent ⇒ no IM owner. */
  transportScope?: string
  /** Platform sender id — never used as a key here; webchat owns its own `webchatOwnerUserId`. */
  triggeredBy?: string
  /** Present ⇒ an A2A child: it inherits from its parent under a row lock (§4.5). */
  parentSessionId?: string
  /** Daemon-reported: this row's coordinates ARE its own conversation (an agent's channel-ROOT
   *  post, or a peer woken by a platform mention there), so a parent link is lineage only. */
  directDestination?: boolean
  /** Resolved `WebchatConversation.userId`, or null when the lookup missed. */
  webchatOwnerUserId?: string | null
  /** Present ⇒ a Web API launch (§4.4); the value is its resolved principal or null. */
  launchCorrelationId?: string
  /** Resolved launching-principal user id, or null when the correlation is unknown. */
  launchOwnerUserId?: string | null
}

/** A settled classification, or the marker that the row must inherit (§4.5). */
export type SessionClassification =
  | { inherit: true }
  | { inherit?: false; visibility: SessionVisibility; ownerIdentity: string | null; source: VisibilitySource }

function isAutomationTrigger(triggeredBy: string | undefined): boolean {
  return triggeredBy != null && AUTOMATION_TRIGGER_PREFIXES.some((prefix) => triggeredBy.startsWith(prefix))
}

/** The IM identity tuple `<platform>:<workspace>:<uid>` (§2). Every segment must
 *  be present: platform uids are unique only per tenant, so a two-segment form
 *  would let two workspaces of one org collide. Missing scope ⇒ no owner. */
function imOwnerIdentity(input: SessionClassificationInput): string | null {
  const { platform, transportScope, triggeredBy } = input
  if (!platform || !transportScope || !triggeredBy) return null
  return `${platform}:${transportScope}:${triggeredBy}`
}

/**
 * Classify a session at ingest. First match wins, mirroring the §4.2 table:
 *
 * | origin                        | visibility      | ownerIdentity                    |
 * | ----------------------------- | --------------- | -------------------------------- |
 * | A2A child (`parentSessionId`) | inherits parent | inherits parent                  |
 * | …that child's own conversation| `private` (DM) / `org` | null (the trigger is the agent) |
 * | webchat / Playground          | `private`       | `user:<WebchatConversation.userId>` |
 * | Web API launch (§4.4)         | `private`       | `user:<launch principal>`        |
 * | cron / hook / dream           | `org`           | null                             |
 * | IM DM                         | `private`       | `<platform>:<scope>:<uid>`       |
 * | IM group DM / channel / absent| `org`           | `<platform>:<scope>:<uid>`       |
 */
export function classifySession(input: SessionClassificationInput): SessionClassification {
  // A2A children copy the parent's tier and owner: a delegation from a private
  // DM or Playground session copies the delegated prompt into the child
  // transcript, so classifying children `org` would expose it to every viewer
  // of the target agent. Resolution needs the parent row under a lock (§4.5).
  if (input.parentSessionId) {
    // …unless the child IS its own conversation: an agent's channel-ROOT post, or a peer woken
    // by a mention observed there. Nothing of the parent's is copied into such a row — its
    // content is what the agent published in that conversation and what people reply there — so
    // inheriting would give it the readers of a conversation it does not live in (§4.2). It
    // classifies by its own shape, unowned: the reporting trigger is the agent, not a person,
    // and a shared external destination is re-bound from the row's own trusted candidate.
    if (input.directDestination) {
      const visibility: SessionVisibility = input.conversationKind === 'dm' ? 'private' : 'org'
      return { visibility, ownerIdentity: null, source: 'default' }
    }
    return { inherit: true }
  }

  // Webchat/Playground. `triggeredBy` here is the console user's email, which
  // degrades under devAuth and is not a stable key — the binding lookup is the
  // authority, and a miss stays private with no owner.
  if (input.platform === 'webchat') {
    const userId = input.webchatOwnerUserId ?? null
    return { visibility: 'private', ownerIdentity: userId ? `user:${userId}` : null, source: 'default' }
  }

  // Web API launch provenance (§4.4): an unresolvable correlation fails closed.
  if (input.launchCorrelationId) {
    const userId = input.launchOwnerUserId ?? null
    return { visibility: 'private', ownerIdentity: userId ? `user:${userId}` : null, source: 'default' }
  }

  // Automation has no human owner; its output is org-visible by default.
  if (input.platform === 'hook' || isAutomationTrigger(input.triggeredBy)) {
    return { visibility: 'org', ownerIdentity: null, source: 'default' }
  }

  // IM. A group DM defaults to `org` like a channel: the predicate can match
  // only one owner, so treating a multi-party conversation as `private` would
  // hide it from its own participants. Its initiator can still pull it private
  // via §4.3 — which is why the owner is recorded for `org` rows too.
  const ownerIdentity = imOwnerIdentity(input)
  const visibility: SessionVisibility = input.conversationKind === 'dm' ? 'private' : 'org'
  return { visibility, ownerIdentity, source: 'default' }
}
