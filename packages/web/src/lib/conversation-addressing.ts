/** Wire mentions for one composer send (webchat-multi-agents.md §4.2).
 *
 * Typed @mentions pass through untouched. A bare send in a multi-agent
 * conversation still carries the PRIMARY participant as a structured mention —
 * the conversation's standing addressee. On that agent's daemon rung the
 * mention is the explicit-address fact (trigger 'mention'), so when a peer
 * answers first, the primary's turn-final re-evaluation keeps answering
 * instead of misfiring into the no-response sentinel — the addressed agent
 * must never be the silent one. Delivery is unaffected: the caller keeps
 * `targets` at the full roster, so the rest of the conversation activates
 * exactly as before.
 */
export function wireMentions(
  roster: ReadonlyArray<{ agentId: string; primary?: boolean }>,
  typedMentions: readonly string[],
  fallbackPrimaryId: string
): string[] {
  if (typedMentions.length > 0 || roster.length <= 1) return [...typedMentions]
  const primaryId = roster.find((p) => p.primary)?.agentId ?? fallbackPrimaryId
  return roster.some((p) => p.agentId === primaryId) ? [primaryId] : []
}
