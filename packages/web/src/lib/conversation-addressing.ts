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

export interface RosterParticipant {
  agentId: string
  name: string
  primary?: boolean
}

/** The composer's roster for one send, in trust order: the settled session
 * state, then the fetched detail of an adopted session, then the creation-time
 * staged ids. The staged fallback exists for the FIRST send of a fresh
 * multi-agent conversation — the provider stages the session and sends in the
 * same tick, so the state read still sees the pre-stage snapshot; without this
 * fallback that first message carries no mentions/targets and the standing
 * mention never reaches the wire. The first staged id is the primary
 * (creation order, webchat-multi-agents.md §3.1). */
export function resolveRoster(
  sessionParticipants: RosterParticipant[] | undefined,
  knownParticipants: RosterParticipant[] | undefined,
  stagedIds: readonly string[] | undefined,
  nameOf: (agentId: string) => string | undefined
): RosterParticipant[] {
  if (sessionParticipants) return sessionParticipants
  if (knownParticipants) return knownParticipants
  if (!stagedIds || stagedIds.length <= 1) return []
  return stagedIds.map((agentId, index) => ({
    agentId,
    name: nameOf(agentId) ?? '',
    ...(index === 0 ? { primary: true } : {})
  }))
}
