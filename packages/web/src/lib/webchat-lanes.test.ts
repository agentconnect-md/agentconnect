import { describe, expect, it } from 'vitest'
import { admitsLane, cursorKeyFor, laneAgentId, laneKey, lanesOf } from './webchat-lanes'

const ID = 'pg_agent-a_x'
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('webchat stream lanes', () => {
  it('round-trips lane keys per (session, participant)', () => {
    const lanes = new Map([[laneKey(ID, A), {}]])
    expect(laneAgentId(laneKey(ID, A))).toBe(A)
    expect(laneAgentId(laneKey(ID))).toBeUndefined()
    expect(lanesOf(lanes, ID)).toEqual([laneKey(ID, A)])
    expect(lanesOf(lanes, 'other')).toEqual([])
  })

  it('agent-tagged frames match their exact lane only — never the sole-lane fallback', () => {
    // The resumed-conversation regression: the client seeded only the primary
    // lane, and the relay (all-participants default) acked a SECOND agent. That
    // tagged ack must NOT capture the primary's cursor — it returns undefined so
    // the caller admits agent B's lane lazily.
    const lanes = new Map([[laneKey(ID, A), {}]])
    expect(cursorKeyFor(lanes, ID, A)).toBe(laneKey(ID, A))
    expect(cursorKeyFor(lanes, ID, B)).toBeUndefined()
  })

  it('reserves the sole-lane fallback for legacy frames without agentId', () => {
    const lanes = new Map([[laneKey(ID, A), {}]])
    // An older daemon omits agentId on every frame — with exactly one live lane
    // the frame unambiguously belongs to it.
    expect(cursorKeyFor(lanes, ID)).toBe(laneKey(ID, A))
    // With several lanes an untagged frame is ambiguous — dropped, not guessed.
    lanes.set(laneKey(ID, B), {})
    expect(cursorKeyFor(lanes, ID)).toBeUndefined()
  })

  it('admits a lane from ANY tagged frame of the in-flight turn — not just the ack', () => {
    // The resumed-conversation wedge: on a warm session the daemon emits its
    // first stream frame synchronously inside turn admission, so output#0 can
    // reach the browser BEFORE the participant's ack. That frame must admit
    // the lane; dropping it strands the ordered cursor at index 0 forever
    // (nothing renders, done is held back, busy never clears).
    const turn = 'turn-1'
    expect(admitsLane(B, turn, turn)).toBe(true)
    // Not for a different (stale) turn, an untagged frame, or with no send in flight.
    expect(admitsLane(B, 'turn-0', turn)).toBe(false)
    expect(admitsLane(undefined, turn, turn)).toBe(false)
    expect(admitsLane(B, turn, undefined)).toBe(false)
    expect(admitsLane(B, undefined, turn)).toBe(false)
  })

  it('after lazy admission, both participants resolve independently', () => {
    const lanes = new Map<string, unknown>([[laneKey(ID, A), {}]])
    // Lazy admission on B's ack: the caller creates the exact lane…
    lanes.set(laneKey(ID, B), {})
    // …and from then on each participant's frames bind their own cursor; one
    // participant's done removing its lane leaves the other untouched.
    expect(cursorKeyFor(lanes, ID, A)).toBe(laneKey(ID, A))
    expect(cursorKeyFor(lanes, ID, B)).toBe(laneKey(ID, B))
    lanes.delete(laneKey(ID, B))
    expect(cursorKeyFor(lanes, ID, A)).toBe(laneKey(ID, A))
    expect(cursorKeyFor(lanes, ID, B)).toBeUndefined()
  })
})
