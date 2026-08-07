// Which lineage a MERGED conversation page draws
// (merged-conversation-view.md §9.1–§9.2).
//
// Two different questions, deliberately kept in two different shapes:
//
// 1. NAVIGATION, out of this conversation. Parent / siblings / children of the
//    whole room, unioned across its members and filtered to targets that live
//    somewhere else. This is §9.2 unchanged.
// 2. ATTRIBUTION, inside it: which member woke which. The merged transcript
//    interleaves its members by TIME, so causation is the one relation it
//    cannot express — reading "Alert Analyzer delegated to node-operator" off
//    the ordering is guesswork.
//
// §9.2 originally dropped (2) entirely, on the reasoning that both ends are
// already on screen. They are, but not their direction. Worse, the information
// was not really gone, it was CONDITIONAL: a member failing closed out of the
// roster dropped the page below the multi-participant threshold, so it stopped
// being a merged page and rendered the representative's own unfiltered family
// instead. The same conversation therefore showed its delegation or hid it
// depending on how many members happened to resolve that second.
//
// The two must NOT share a shape. `family` is navigation in the UI — a
// `parentSessions` entry links AWAY, to another conversation — so putting a
// co-participant there hands the reader a link back to the page they are on.
// Attribution is therefore its own structure, anchored on the open row: who
// woke it, and whom it woke. The rail draws both on the same three levels
// (waker · open row · woken), since they are one edge seen from two locations.

import type { SessionRelationDto } from '@/lib/api'

/** Where a lineage target lives, relative to the page asking.
 *  `singleton` is a readable target with no groupable channel/thread — it cannot
 *  share this page's location, so it is always elsewhere. `unreadable` is a
 *  target whose detail the caller could not fetch. */
export type LineageTargetLocation = { kind: 'key'; key: string } | { kind: 'singleton' } | { kind: 'unreadable' }

/** The member detail this module reads. Structural, so it accepts a
 *  `SessionDetailDto` without dragging the rest of that surface in. */
export interface LineageMemberDetail {
  id: string
  agentId: string
  parentSession: SessionRelationDto | null
  childSessions: SessionRelationDto[]
}

export interface ConversationLineage {
  /** Navigation OUT of this conversation (§9.2), unchanged. */
  family: {
    /** Every conversation that woke a member of this one. A merged page has as
     *  many as it has members with a cross-room parent, and they are all the
     *  SAME relation — so they stay in ONE list rather than a privileged head
     *  plus a tail borrowing some other slot's name. There is deliberately no
     *  sibling slot here: "sibling" is lineage's own word for the other
     *  children of one parent session (§9.1), which is a per-session fact a
     *  conversation has no version of. */
    parentSessions: SessionRelationDto[]
    childSessions: SessionRelationDto[]
  }
  /** Delegation target id → the agent whose member session woke it. */
  childOriginById: Map<string, string>
  /** Attribution INSIDE this conversation, anchored on the open row. Both sides
   *  are fellow participants, so neither is a navigation target — the UI labels
   *  them as delegation, never as another conversation. */
  roomLineage: {
    /** The participant that woke the open row, if one did. */
    wokenBy: SessionRelationDto | null
    /** The participants the open row woke. */
    woke: SessionRelationDto[]
  }
}

/** Whether a target lies OUTSIDE the asking conversation, so an edge to it is
 *  navigation. Unreadable fails closed: the caller could not open it either, so
 *  naming it only advertises something unreachable. */
export function isCrossRoom(target: LineageTargetLocation | undefined, conversationKey: string | null): boolean {
  if (!target || target.kind === 'unreadable') return false
  return target.kind === 'singleton' || target.key !== conversationKey
}

/**
 * Build both halves from the members' details.
 *
 * Attribution is read from the REPRESENTATIVE's own edges rather than unioned
 * across the room, and that is what makes it directional: "who woke the row you
 * are looking at" and "whom it woke" stay meaningful however the representative
 * rotates — and it rotates whenever either agent speaks, since it is the newest
 * visible member. A union cannot say that: the same A → B edge is A's child and
 * B's parent at once, so a symmetric filter lands one of them in `family` and
 * mislabels a co-participant as a parent conversation.
 *
 * Only fellow MEMBERS count as attribution. A superseded session at this
 * location is not a member — it is an earlier incarnation of one — and stays
 * dropped, which is the case §9.1 was really guarding.
 */
export function assembleConversationLineage(input: {
  conversationKey: string | null
  members: readonly { sessionId: string }[]
  details: readonly (LineageMemberDetail | null)[]
  targetLocations: ReadonlyMap<string, LineageTargetLocation>
}): ConversationLineage {
  const { conversationKey, members, details, targetLocations } = input
  const memberIds = new Set(members.map((member) => member.sessionId))
  const representativeId = members[0]?.sessionId

  const parents = new Map<string, SessionRelationDto>()
  const children = new Map<string, SessionRelationDto>()
  const childOriginById = new Map<string, string>()
  for (const detail of details) {
    if (!detail) continue
    if (detail.parentSession && !parents.has(detail.parentSession.id)) {
      parents.set(detail.parentSession.id, detail.parentSession)
    }
    for (const child of detail.childSessions) {
      if (children.has(child.id)) continue
      children.set(child.id, child)
      childOriginById.set(child.id, detail.agentId)
    }
  }

  const crossParents = [...parents.values()].filter((p) => isCrossRoom(targetLocations.get(p.id), conversationKey))
  const crossChildren = [...children.values()]
    .filter((c) => isCrossRoom(targetLocations.get(c.id), conversationKey))
    // Origin-adjacent order — the family UI renders delegation groups from this
    // plus childOriginById.
    .sort((a, b) => {
      const ao = childOriginById.get(a.id) ?? ''
      const bo = childOriginById.get(b.id) ?? ''
      return ao < bo ? -1 : ao > bo ? 1 : a.id < b.id ? -1 : 1
    })

  // Attribution: the open row's own edges, kept only when they point at another
  // participant that is actually on this page.
  const isParticipant = (id: string): boolean =>
    id !== representativeId &&
    memberIds.has(id) &&
    !isCrossRoom(targetLocations.get(id), conversationKey) &&
    targetLocations.get(id)?.kind === 'key'
  const representative = details.find((detail) => detail?.id === representativeId) ?? null
  const wokenBy =
    representative?.parentSession && isParticipant(representative.parentSession.id)
      ? representative.parentSession
      : null
  const woke = (representative?.childSessions ?? []).filter((child) => isParticipant(child.id))

  return {
    family: {
      // Member order, which is the roster's order: nothing here ranks one
      // waking conversation above another, so none of them is singled out.
      parentSessions: crossParents,
      childSessions: crossChildren
    },
    childOriginById,
    roomLineage: { wokenBy, woke }
  }
}
