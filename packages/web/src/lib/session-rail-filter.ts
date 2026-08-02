// The session rail's agent filter, and the one rule that governs it: an untouched
// filter follows whichever session is open; an edited one outranks the route.
//
// This exists because the session detail view SURVIVES rail navigation — the route
// frame lives in the sessions layout, so moving between /sessions/a and /sessions/b
// never remounts it and there is no mount to re-seed the default on. Re-seeding on
// every session change instead would undo the reader's edit the moment they clicked
// a row; never re-seeding would leave a stale agent's name on the chip after a
// lineage link carried them into another agent's session.

export interface RailAgentFilter {
  /** Agents the rail's list is filtered to. Empty = every session the viewer can see. */
  agentIds: string[]
  /** Whether the reader has edited the filter, which freezes it against re-seeding. */
  touched: boolean
}

export const EMPTY_RAIL_AGENT_FILTER: RailAgentFilter = { agentIds: [], touched: false }

/**
 * The filter after the open session resolved to `sessionAgentId` ('' while unknown).
 * Returns `prev` unchanged whenever nothing moved, so this is safe to call from a
 * state updater on every render without churning the subscribers of `agentIds`.
 */
export function seedRailAgentFilter(prev: RailAgentFilter, sessionAgentId: string): RailAgentFilter {
  if (prev.touched) return prev
  const agentIds = sessionAgentId ? [sessionAgentId] : []
  const unchanged = prev.agentIds.length === agentIds.length && prev.agentIds[0] === agentIds[0]
  return unchanged ? prev : { agentIds, touched: false }
}
