// Which lineage edges a MERGED conversation page draws
// (merged-conversation-view.md §9.1–§9.2).
//
// A merged page collapses every member session of one channel+thread into a
// single transcript, so most of what a single session's family tree offers is
// already on screen. §9.2 concluded from that it should drop every intra-room
// edge and keep only the ones leaving the room.
//
// It drops too much. The transcript interleaves its members by TIME, which makes
// exactly one relation unrepresentable in it: which member woke which. "Alert
// Analyzer delegated to node-operator" is a fact about causation, and reading it
// off a time-ordered merge is guesswork.
//
// That information was not actually gone before — it was CONDITIONAL. When a
// member failed closed out of the roster (a degraded external access check), the
// page fell below the multi-participant threshold, stopped being a merged page,
// and rendered the representative's own unfiltered family instead. So the same
// conversation showed its delegation or hid it depending on how many members
// happened to resolve that second. This module is what makes the answer the same
// either way.

/** Where a lineage target lives, relative to the page asking.
 *  `singleton` is a readable target with no groupable channel/thread — it cannot
 *  share this page's location, so it is always elsewhere. `unreadable` is a
 *  target whose detail the caller could not fetch. */
export type LineageTargetLocation = { kind: 'key'; key: string } | { kind: 'singleton' } | { kind: 'unreadable' }

/**
 * Whether a merged page should draw the edge pointing at `targetId`.
 *
 * Cross-room edges are kept as they always were: they leave this conversation,
 * so nothing on this page already stands for them.
 *
 * Intra-room edges are kept only when the target is a fellow PARTICIPANT — that
 * is the delegation structure, and it is the part the merged transcript cannot
 * express. Two intra-room targets are still dropped:
 *
 * - a SUPERSEDED session at this location, which is not a member. This is the
 *   case §9.1 was really protecting against: an older ACP session of the same
 *   thread is not a second participant, just an earlier incarnation of one.
 * - the REPRESENTATIVE, which the family UI already draws as the highlighted
 *   `current` row. Keeping it would render the open session twice — and in the
 *   common one-delegation case, that duplicate would be the only thing the tree
 *   had to say.
 *
 * An unreadable target fails closed, unchanged: the caller could not open it
 * either, so naming it would only advertise something they cannot reach.
 */
export function keepLineageTarget(
  targetId: string,
  target: LineageTargetLocation | undefined,
  room: {
    /** The §5.1 key of the page doing the asking. */
    conversationKey: string | null
    /** Session ids of every member the resolver returned. */
    memberIds: ReadonlySet<string>
    /** The member this page is centred on (the resolver's newest visible one). */
    representativeId?: string | undefined
  }
): boolean {
  if (!target || target.kind === 'unreadable') return false
  if (target.kind === 'singleton' || target.key !== room.conversationKey) return true
  return room.memberIds.has(targetId) && targetId !== room.representativeId
}
