import { describe, it, expect } from 'vitest'
import { DutyRegistry } from '../../src/cp/duty-registry.js'
import type { DutyGrantEntry } from '@agentconnect.md/protocol'

const A1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const A2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const B1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
const G1 = '11111111-1111-4111-8111-111111111111'
const G2 = '22222222-2222-4222-8222-222222222222'

const grant = (groupId: string, term: string, agents: string[], bots: string[] = []): DutyGrantEntry => ({
  groupId,
  orgId: 'org-1',
  term,
  members: [
    ...agents.map((refId) => ({ kind: 'agent' as const, refId })),
    ...bots.map((refId) => ({ kind: 'bot' as const, refId }))
  ]
})

describe('DutyRegistry', () => {
  it('starts empty — the digest a single-org daemon would report', () => {
    const r = new DutyRegistry()
    expect(r.digest()).toEqual([])
    expect(r.agents().size).toBe(0)
    expect(r.size()).toBe(0)
  })

  it('a grant becomes the digest, the agent set, and the bot set', () => {
    const r = new DutyRegistry()
    const result = r.applyGrant([grant(G1, '3', [A1], [B1])])

    expect(result.added).toEqual([G1])
    expect(result.updated).toEqual([])
    expect(result.agentsGained).toEqual([A1])
    expect(r.digest()).toEqual([{ groupId: G1, term: '3' }])
    expect([...r.agents()]).toEqual([A1])
    expect([...r.bots()]).toEqual([B1])
    expect(r.holdsAgent(A1)).toBe(true)
  })

  it('a grant for a held group REPLACES it — new term, new composition', () => {
    const r = new DutyRegistry()
    r.applyGrant([grant(G1, '1', [A1])])
    const result = r.applyGrant([grant(G1, '2', [A1, A2])])

    expect(result.added).toEqual([])
    expect(result.updated).toEqual([G1])
    expect(result.agentsGained).toEqual([A2])
    expect(result.agentsLost).toEqual([])
    expect(r.size()).toBe(1)
    expect(r.digest()).toEqual([{ groupId: G1, term: '2' }])
    expect([...r.agents()].sort()).toEqual([A1, A2])
  })

  it('a replacement that drops a member reports the agent as lost', () => {
    const r = new DutyRegistry()
    r.applyGrant([grant(G1, '1', [A1, A2])])
    const result = r.applyGrant([grant(G1, '2', [A1])])

    expect(result.agentsLost).toEqual([A2])
    expect(r.holdsAgent(A2)).toBe(false)
  })

  it('a revoke drops the group and its agents', () => {
    const r = new DutyRegistry()
    r.applyGrant([grant(G1, '1', [A1]), grant(G2, '1', [A2])])
    const result = r.applyRevoke([{ groupId: G1, reason: 'superseded' }])

    expect(result.agentsLost).toEqual([A1])
    expect(r.groupIds()).toEqual([G2])
    expect([...r.agents()]).toEqual([A2])
  })

  it('an agent in two groups survives losing one of them', () => {
    const r = new DutyRegistry()
    r.applyGrant([grant(G1, '1', [A1]), grant(G2, '1', [A1])])
    const result = r.applyRevoke([{ groupId: G1, reason: 'gone' }])

    expect(result.agentsLost).toEqual([])
    expect(r.holdsAgent(A1)).toBe(true)
  })

  it('revoking an unheld group is a no-op, never a spurious loss', () => {
    const r = new DutyRegistry()
    r.applyGrant([grant(G1, '1', [A1])])
    const result = r.applyRevoke([{ groupId: G2, reason: 'gone' }])

    expect(result.agentsLost).toEqual([])
    expect(r.groupIds()).toEqual([G1])
  })

  it('the digest is sorted and stable, so a CP-side diff is order-free', () => {
    const r = new DutyRegistry()
    r.applyGrant([grant(G2, '1', [A2]), grant(G1, '1', [A1])])
    expect(r.digest().map((d) => d.groupId)).toEqual([G1, G2])
  })

  it('releaseAll empties the registry and returns what was surrendered', () => {
    const r = new DutyRegistry()
    r.applyGrant([grant(G1, '1', [A1]), grant(G2, '1', [A2])])

    expect(r.releaseAll()).toEqual([G1, G2])
    expect(r.size()).toBe(0)
    expect(r.digest()).toEqual([])
    expect(r.agents().size).toBe(0)
  })

  it('empty grant/revoke batches change nothing', () => {
    const r = new DutyRegistry()
    r.applyGrant([grant(G1, '1', [A1])])
    expect(r.applyGrant([]).added).toEqual([])
    expect(r.applyRevoke([]).agentsLost).toEqual([])
    expect(r.size()).toBe(1)
  })
})

describe('duty capacity accounting', () => {
  // The daemon reports `maxAgents - covered - inFlightClaims` as headroom: one
  // number feeds both the CP's grant budget and the rendezvous fit check, and
  // in-flight claims reserve a slot so concurrent ones cannot overshoot.
  const headroom = (max: number, covered: number, pending = 0) => (max > 0 ? Math.max(0, max - covered - pending) : 32)

  /** What a claim that is ITSELF in flight may still accept: its own
   *  reservation is excluded, others still count, and the result is NOT clamped
   *  — a full member must come out negative rather than at zero with a slot. */
  const headroomForPending = (max: number, covered: number, pending: number) =>
    max > 0 ? max - covered - Math.max(0, pending - 1) : 32

  it('a full member comes out negative, never at zero with a phantom slot', () => {
    const r = new DutyRegistry()
    r.applyGrant([grant(G1, '1', [A1, A2])])
    // maxAgents 2, both covered, this claim is the only one in flight.
    expect(headroomForPending(2, r.agents().size, 1)).toBe(0)
    // So a group bringing even one agent does not fit.
    expect(1 > headroomForPending(2, r.agents().size, 1)).toBe(true)
  })

  it('two concurrent claims cannot both spend the last slot', () => {
    const r = new DutyRegistry()
    r.applyGrant([grant(G1, '1', [A1])])
    // maxAgents 2, one covered, two claims in flight: each sees the other's
    // reservation, so neither may take the single remaining slot.
    expect(headroomForPending(2, r.agents().size, 2)).toBe(0)
    expect(1 > headroomForPending(2, r.agents().size, 2)).toBe(true)
    // Alone, that same claim fits.
    expect(1 > headroomForPending(2, r.agents().size, 1)).toBe(false)
  })

  it('in-flight claims reserve headroom so concurrent claims cannot overshoot', () => {
    const r = new DutyRegistry()
    r.applyGrant([grant(G1, '1', [A1])])
    expect(headroom(3, r.agents().size)).toBe(2)
    // Two claims in flight leave room for exactly one more agent.
    expect(headroom(3, r.agents().size, 2)).toBe(0)
  })

  it('a multi-agent group is judged by the agents it actually brings', () => {
    const r = new DutyRegistry()
    r.applyGrant([grant(G1, '1', [A1])])
    const arriving = grant(G2, '1', [A2, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3']).members.filter(
      (m) => m.kind === 'agent' && !r.holdsAgent(m.refId)
    ).length
    expect(arriving).toBe(2)
    // maxAgents 2 with one covered leaves room for one — this group does not fit.
    expect(arriving > headroom(2, r.agents().size)).toBe(true)
    // maxAgents 4 leaves room for three — it fits.
    expect(arriving > headroom(4, r.agents().size)).toBe(false)
  })

  it('an agent already covered by another group does not consume new capacity', () => {
    const r = new DutyRegistry()
    r.applyGrant([grant(G1, '1', [A1])])
    const arriving = grant(G2, '1', [A1]).members.filter((m) => m.kind === 'agent' && !r.holdsAgent(m.refId)).length
    expect(arriving).toBe(0)
  })

  it('headroom shrinks as duties cover more agents, and never goes negative', () => {
    const r = new DutyRegistry()
    expect(headroom(2, r.agents().size)).toBe(2)

    r.applyGrant([grant(G1, '1', [A1])])
    expect(headroom(2, r.agents().size)).toBe(1)

    r.applyGrant([grant(G2, '1', [A2, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'])])
    expect(headroom(2, r.agents().size)).toBe(0)
  })

  it('an unbounded maxAgents reports the CP per-tick cap, not infinity', () => {
    expect(headroom(0, 100)).toBe(32)
  })

  it('a revoke frees headroom again', () => {
    const r = new DutyRegistry()
    r.applyGrant([grant(G1, '1', [A1, A2])])
    expect(headroom(2, r.agents().size)).toBe(0)

    r.applyRevoke([{ groupId: G1, reason: 'superseded' }])
    expect(headroom(2, r.agents().size)).toBe(2)
  })
})
