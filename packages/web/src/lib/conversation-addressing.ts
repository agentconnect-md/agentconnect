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

/** What still counts as the SAME name one character later. Unicode-aware on
 *  purpose: display names are free-form (`min(1).max(120)`, no charset), so a
 *  name can end in a CJK character, an emoji, or punctuation, and JavaScript's
 *  `\b` — ASCII-word based — reports no boundary after any of them. Matching on
 *  `\b` therefore dropped "@研究助理 have a look" on the floor, and a dropped
 *  mention is not a no-op: it degrades the send to the standing mention and
 *  wakes the whole roster. */
const NAME_CHAR = '[\\p{L}\\p{N}_]'
const NAME_CHAR_RE = new RegExp(NAME_CHAR, 'u')

/** Resolve the @mentions typed into one composer send to roster agentIds
 *  (webchat-multi-agents.md §4.2 — mentions narrow the turn; the empty result
 *  means "no narrowing", not "nobody").
 *
 *  Text matching is the stopgap: §4.1 wants the composer to emit ID-backed
 *  chips, so that the wire carries a structural fact rather than a guess. Until
 *  it does, the guess should at least not wake an agent nobody addressed, so a
 *  name matches only where it is the LONGEST roster name at that `@` and is not
 *  glued to a neighbouring word on either side — "@agent-2" belongs to
 *  `agent-2` alone even with an `agent` in the room, and "ping foo@test.dev"
 *  addresses no one.
 */
export function typedMentionIds(
  roster: ReadonlyArray<{ agentId: string; name?: string | null }>,
  text: string
): string[] {
  if (roster.length <= 1) return []
  // offset of an `@` → the longest name matched there, and who answers to it
  const claims = new Map<number, { len: number; ids: string[] }>()
  for (const p of roster) {
    const name = p.name?.trim()
    if (!name) continue
    const at = new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!${NAME_CHAR})`, 'giu')
    for (const m of text.matchAll(at)) {
      const start = m.index ?? 0
      // Left edge: an `@` welded to a preceding word is an address, not a mention.
      if (start > 0 && NAME_CHAR_RE.test(text[start - 1]!)) continue
      const claim = claims.get(start)
      if (!claim || m[0].length > claim.len) claims.set(start, { len: m[0].length, ids: [p.agentId] })
      // Two participants sharing a display name are genuinely ambiguous — wake both.
      else if (m[0].length === claim.len && !claim.ids.includes(p.agentId)) claim.ids.push(p.agentId)
    }
  }
  const mentioned = new Set([...claims.values()].flatMap((c) => c.ids))
  return roster.filter((p) => mentioned.has(p.agentId)).map((p) => p.agentId)
}

/** The @mention being typed at `caret`, if any (composer autocomplete —
 *  webchat-multi-agents.md §9.1/§9.2). Mirrors typedMentionIds' left-edge rule:
 *  an `@` glued to a preceding word addresses no one, so it never opens the
 *  picker either. A space since the `@` ends the query — the picker narrows on
 *  the first word only; a multi-word display name still lands in full because
 *  picking inserts the whole name, not just what was typed.
 */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, caret)
  const at = upto.lastIndexOf('@')
  if (at === -1) return null
  const query = upto.slice(at + 1)
  if (/\s/.test(query)) return null
  if (at > 0 && NAME_CHAR_RE.test(upto[at - 1]!)) return null
  return { start: at, query }
}

/** Where a `/sessions/:id` deep link goes when its session turns out to belong
 *  to a multi-participant conversation (merged-conversation-view.md §5.3).
 *
 *  The path is BARE. The landing carries no per-participant focus, so arriving
 *  from a GitHub footer or a shared URL looks exactly like arriving from the
 *  list — no scroll jump, no highlighted block. `view=flat` is the diagnostic
 *  route and opts out of the redirect entirely. */
export function selfConversationPath(input: {
  flatView: boolean
  conversationKey: string | null
  memberCount: number
}): string | null {
  if (input.flatView || !input.conversationKey || input.memberCount <= 1) return null
  return `/conversations/${encodeURIComponent(input.conversationKey)}`
}
