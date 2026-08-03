/** Wire mentions for one composer send (webchat-multi-agents.md §4.2).
 *
 * Conversation membership is a STANDING mention. Typed @mentions narrow the
 * turn and pass through untouched; a bare send materializes that standing
 * mention as the WHOLE roster in the structured `mentions` array — exactly the
 * shape an explicit "@everyone" message produces. On each participant's daemon
 * rung, seeing itself in the list is the explicit-address fact
 * (trigger 'mention'), so when peers answer the same message in parallel, a
 * slower agent's turn-final re-evaluation keeps answering instead of misfiring
 * into the no-response sentinel — no participant can go silent by losing the
 * race.
 */
export function wireMentions(roster: ReadonlyArray<{ agentId: string }>, typedMentions: readonly string[]): string[] {
  if (typedMentions.length > 0 || roster.length <= 1) return [...typedMentions]
  return roster.map((p) => p.agentId)
}
