// Stream-lane keying for multi-agent webchat conversations
// (webchat-multi-agents.md §5.3): one ordering cursor per (session, participant)
// lane, keyed `${id} ${agentId}`. Pure helpers over the provider's cursor map so
// the resolution rules are unit-testable.

/** The cursor-map key for one participant's stream lane. */
export function laneKey(id: string, agentId?: string): string {
  return `${id}\u0000${agentId ?? ''}`
}

/** The participant a lane key addresses (undefined for the anonymous lane). */
export function laneAgentId(key: string): string | undefined {
  const agentId = key.slice(key.indexOf('\u0000') + 1)
  return agentId || undefined
}

/** Every lane key belonging to one session id. */
export function lanesOf(lanes: ReadonlyMap<string, unknown>, id: string): string[] {
  return [...lanes.keys()].filter((k) => k.startsWith(`${id}\u0000`))
}

/**
 * Resolve the lane a frame belongs to.
 *
 * Agent-tagged frames match their EXACT lane only — a tagged ack/output for a
 * participant the client has not laned yet must return undefined so the caller
 * can admit the lane lazily (a resumed conversation where the relay applied the
 * all-participants default). The sole-lane compatibility fallback is reserved
 * for legacy frames that omit `agentId`: letting a tagged frame fall back would
 * share the primary's cursor across participants, misattributing or dropping
 * replies once one participant's `done` removes it.
 */
export function cursorKeyFor(lanes: ReadonlyMap<string, unknown>, id: string, agentId?: string): string | undefined {
  const exact = laneKey(id, agentId)
  if (lanes.has(exact)) return exact
  if (agentId !== undefined) return undefined
  const all = lanesOf(lanes, id)
  return all.length === 1 ? all[0] : undefined
}
