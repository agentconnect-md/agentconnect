// The session rail's agent filter, and the one rule that governs it: an untouched
// filter follows whichever conversation is open; an edited one outranks the route.
//
// This exists because the session detail view SURVIVES rail navigation — the route
// frame lives in the sessions layout, so moving between /sessions/a and /sessions/b
// never remounts it and there is no mount to re-seed the default on. Re-seeding on
// every session change instead would undo the reader's edit the moment they clicked
// a row; never re-seeding would leave a stale agent's name on the chip after a
// lineage link carried them into another agent's session.
//
// The seed is every agent in the open CONVERSATION, not just the session's owner:
// on a thread two agents worked in, the rail's default question is "the other
// threads these two worked in together", which is exactly what the CP answers for
// a repeated `agentId` (merged-conversation-view.md §5.1 grouping).
//
// Order carries no meaning here — the CP's answer does not depend on it — so the
// ids are held sorted to keep the state from churning as the roster reshuffles.

export interface RailAgentFilter {
  /** Agents the rail's list is filtered to. Empty = every session the viewer can see. */
  agentIds: string[]
  /** Whether the reader has edited the filter, which freezes it against re-seeding. */
  touched: boolean
}

export const EMPTY_RAIL_AGENT_FILTER: RailAgentFilter = { agentIds: [], touched: false }

/**
 * The agents the open route seeds the filter with, most authoritative source
 * first:
 *
 * 1. the conversation's members, as the CP's resolver reported them;
 * 2. the CLIENT-side roster, for the one conversation no resolver can answer
 *    for — a live playground conversation exists only in this browser until its
 *    first turn persists, and seeding its owner alone filtered the rail to one
 *    participant of a conversation the reader is watching several agents work in;
 * 3. the owning agent, for an ordinary single-agent session.
 *
 * Empty means "nothing to seed yet", which {@link seedRailAgentFilter} leaves
 * unseeded rather than treating as a cleared filter.
 */
export function railSeedAgentIds(
  conversationRoster: readonly { agentId?: string | null }[] | null | undefined,
  liveRosterAgentIds: readonly string[],
  ownerAgentId?: string | null
): string[] {
  if (conversationRoster && conversationRoster.length > 0) return conversationRoster.map((m) => m.agentId ?? '')
  if (liveRosterAgentIds.length > 0) return [...liveRosterAgentIds]
  return ownerAgentId ? [ownerAgentId] : []
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

/**
 * The filter after the open conversation resolved to `conversationAgentIds` (empty
 * while unknown). Pure, and returns `chosen` unchanged whenever nothing moved, so
 * the caller can derive it during render — seeding from an effect instead would
 * commit one frame carrying the unseeded filter even though the agents are already
 * known.
 */
export function seedRailAgentFilter(chosen: RailAgentFilter, conversationAgentIds: readonly string[]): RailAgentFilter {
  if (chosen.touched) return chosen
  // Sorted, because the roster arrives in last-activity order: leaving it alone
  // would re-seed the filter — and reshuffle the chips — every time one of the
  // agents said something. Ids sort arbitrarily but STABLY, which is all the
  // state needs; the chips are ordered by name where they are rendered.
  const agentIds = [...new Set(conversationAgentIds)].filter(Boolean).sort()
  return sameIds(chosen.agentIds, agentIds) ? chosen : { agentIds, touched: false }
}

/**
 * The session-list query a seeded filter asks for, or `null` when it asks nothing
 * yet. Only an UNTOUCHED empty filter means "the conversation has not resolved" — a
 * fetch there would be thrown away the moment it seeds. An empty filter the reader
 * cleared themselves is a real question, and its answer is every session they can
 * see, so it returns a query with no `agentId`.
 */
export function railAgentFilterQuery(filter: RailAgentFilter): { agentId?: string[] } | null {
  if (filter.agentIds.length > 0) return { agentId: [...filter.agentIds] }
  return filter.touched ? {} : null
}

/**
 * Whether a SEEDED filter's answer collapsed to the conversation already on screen,
 * so the rail should re-ask its question unfiltered.
 *
 * The rail hides itself when it has fewer than two rows to offer — and hiding takes
 * the chips and the agent picker with it, so a seed that narrowed the list that far
 * leaves the reader an empty gutter with no way to widen it. Multiple agents are the
 * usual route in: repeated `agentId` asks the CP for the conversations those agents
 * SHARE, and a thread they have only ever worked in together once answers with
 * exactly that thread. A single agent lands in the same place whenever the open
 * session is the only one it owns.
 *
 * A TOUCHED filter is never widened: a narrow result is a real answer to the
 * reader's own question, and broadening it would silently overrule them. `loading`
 * defers the decision — an in-flight page looks identical to a collapsed one from
 * here (no rows, zero total), and widening on that would fire a request per load.
 */
export function railSeedCollapsed(filter: RailAgentFilter, rows: number, total: number, loading: boolean): boolean {
  if (filter.touched || filter.agentIds.length === 0 || loading) return false
  return Math.max(total, rows) < 2
}
