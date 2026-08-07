import { describe, expect, it } from 'vitest'
import {
  assembleConversationLineage,
  isCrossRoom,
  type LineageMemberDetail,
  type LineageTargetLocation
} from './conversation-lineage'

// A conversation key is opaque here — the real encoder joins its parts with a NUL,
// but these only ever get compared for equality, so a printable placeholder keeps
// the file diffable and reviewable on GitHub.
const ROOM = 'room-1'
const OTHER_ROOM = 'room-2'

const A = 'session-a' // Alert Analyzer, the delegating member
const B = 'session-b' // node-operator, the member it woke

const relation = (id: string) => ({ id, agentId: `agent-of-${id}`, title: `Session ${id}`, platform: 'slack' })

function detail(
  id: string,
  { parent, children = [] }: { parent?: string; children?: string[] } = {}
): LineageMemberDetail {
  return {
    id,
    agentId: `agent-of-${id}`,
    parentSession: parent ? relation(parent) : null,
    childSessions: children.map(relation)
  }
}

const at = (key: string): LineageTargetLocation => ({ kind: 'key', key })

/** The reported shape: one Slack thread, A woke B, both members. `members[0]` is
 *  the representative, which is why rotation is expressed by ordering. */
function room(order: string[], extra: Record<string, LineageTargetLocation> = {}) {
  return assembleConversationLineage({
    conversationKey: ROOM,
    members: order.map((sessionId) => ({ sessionId })),
    details: [detail(A, { children: [B] }), detail(B, { parent: A })],
    targetLocations: new Map<string, LineageTargetLocation>([[A, at(ROOM)], [B, at(ROOM)], ...Object.entries(extra)])
  })
}

describe('isCrossRoom', () => {
  it('keeps a target in another conversation', () => {
    expect(isCrossRoom(at(OTHER_ROOM), ROOM)).toBe(true)
  })

  it('treats an ungroupable target as elsewhere', () => {
    expect(isCrossRoom({ kind: 'singleton' }, ROOM)).toBe(true)
  })

  it('does not treat a same-location target as navigation', () => {
    expect(isCrossRoom(at(ROOM), ROOM)).toBe(false)
  })

  it('fails closed on a target it could not read', () => {
    expect(isCrossRoom({ kind: 'unreadable' }, ROOM)).toBe(false)
    expect(isCrossRoom(undefined, ROOM)).toBe(false)
  })
})

describe('assembleConversationLineage', () => {
  it('never puts a co-participant in family, whichever member is representative', () => {
    // The regression this guards: `family.parentSession` renders as "Parent
    // conversation" and links away, so a member of THIS room landing there
    // mislabels it and links back to the page you are already on.
    for (const order of [
      [B, A],
      [A, B]
    ]) {
      const { family } = room(order)
      expect(family.parentSessions).toEqual([])
      expect(family.childSessions).toEqual([])
    }
  })

  it('reads attribution from the open row, so it survives representative rotation', () => {
    // The representative is the NEWEST visible member, so it changes whenever
    // either agent speaks. The delegation is a fact about the room and must not
    // flip direction — or vanish — as that rotates.
    expect(room([B, A]).roomLineage).toEqual({ wokenBy: relation(A), woke: [] })
    expect(room([A, B]).roomLineage).toEqual({ wokenBy: null, woke: [relation(B)] })
  })

  it('still lifts an edge that leaves the conversation', () => {
    const out = assembleConversationLineage({
      conversationKey: ROOM,
      members: [{ sessionId: A }],
      details: [detail(A, { parent: 'far-parent', children: ['far-child'] })],
      targetLocations: new Map([
        ['far-parent', at(OTHER_ROOM)],
        ['far-child', { kind: 'singleton' } as LineageTargetLocation]
      ])
    })

    expect(out.family.parentSessions).toEqual([relation('far-parent')])
    expect(out.family.childSessions).toEqual([relation('far-child')])
    expect(out.roomLineage).toEqual({ wokenBy: null, woke: [] })
    expect(out.childOriginById.get('far-child')).toBe(`agent-of-${A}`)
  })

  it('drops a superseded session at this location from both halves', () => {
    // Not a member — an earlier ACP session of the same thread is a previous
    // incarnation of a participant, not a second one. This is the case §9.1 was
    // really guarding, and it stays guarded.
    const out = assembleConversationLineage({
      conversationKey: ROOM,
      members: [{ sessionId: B }],
      details: [detail(B, { parent: 'session-superseded' })],
      targetLocations: new Map([['session-superseded', at(ROOM)]])
    })

    expect(out.family.parentSessions).toEqual([])
    expect(out.roomLineage.wokenBy).toBeNull()
  })

  it('fails closed on an unreadable participant edge', () => {
    const out = room([B, A], { [A]: { kind: 'unreadable' } })

    expect(out.roomLineage.wokenBy).toBeNull()
    expect(out.family.parentSessions).toEqual([])
  })

  it('keeps every cross-room parent as a parent', () => {
    // The regression this guards: with only one parent SLOT, the second waking
    // conversation had to go somewhere, and it went into `siblingSessions` —
    // which on a single-session page means the other children of one parent.
    // The rail then drew it at the open row's own level, below a divider,
    // describing a conversation that woke this one as a peer of it.
    const out = assembleConversationLineage({
      conversationKey: ROOM,
      members: [{ sessionId: A }, { sessionId: B }],
      details: [detail(A, { parent: 'far-parent-1' }), detail(B, { parent: 'far-parent-2' })],
      targetLocations: new Map([
        ['far-parent-1', at(OTHER_ROOM)],
        ['far-parent-2', at('room-3')]
      ])
    })

    expect(out.family.parentSessions).toEqual([relation('far-parent-1'), relation('far-parent-2')])
    expect(out.family.childSessions).toEqual([])
  })

  it('deduplicates one shared parent across members', () => {
    const out = assembleConversationLineage({
      conversationKey: ROOM,
      members: [{ sessionId: A }, { sessionId: B }],
      details: [detail(A, { parent: 'far-parent' }), detail(B, { parent: 'far-parent' })],
      targetLocations: new Map([['far-parent', at(OTHER_ROOM)]])
    })

    expect(out.family.parentSessions).toEqual([relation('far-parent')])
  })

  it('ignores a member whose detail could not be fetched', () => {
    const out = assembleConversationLineage({
      conversationKey: ROOM,
      members: [{ sessionId: A }, { sessionId: B }],
      details: [null, detail(B, { parent: A })],
      targetLocations: new Map([[A, at(ROOM)]])
    })

    // The representative's own detail is the missing one, so there is nothing to
    // attribute from — and nothing is invented from the other member's copy.
    expect(out.roomLineage).toEqual({ wokenBy: null, woke: [] })
  })
})
