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

export interface RailAgentFilter {
  /** Agents the rail's list is filtered to. Empty = every session the viewer can see. */
  agentIds: string[]
  /** Whether the reader has edited the filter, which freezes it against re-seeding. */
  touched: boolean
}

export const EMPTY_RAIL_AGENT_FILTER: RailAgentFilter = { agentIds: [], touched: false }

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
  // De-duplicated but NOT sorted: the roster arrives in the conversation's own
  // order (its primary agent first), which is the order the chips should read in.
  const agentIds = [...new Set(conversationAgentIds)].filter(Boolean)
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
