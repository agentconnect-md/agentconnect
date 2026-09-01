// The card's default derivation against the cases `HttpBotOrchestrator.compile` actually
// distinguishes. Membership order alone was wrong in both directions: it marked a member
// the compiler skips, and — the part that loses data — left the real default's Remove
// enabled, so removing it stranded every bare delegation on the workspace.

import { describe, expect, it } from 'vitest'
import { linearDefaultAgents, linearMemberEligibility, type LinearMemberAgent } from './default-agent'

/** A placed, org-visible agent — the compiler's `placed && !gated`. */
function placed(over: Partial<LinearMemberAgent> = {}): LinearMemberAgent {
  return { visibility: 'org', placementKind: 'daemon', setId: null, daemon: 'daemon-1', ...over }
}

const restricted = () => placed({ visibility: 'restricted' })
const unplaced = () => placed({ daemon: '—' })
const onSet = () => placed({ placementKind: 'set', setId: 'set-1', daemon: 'pool' })

const roster = (entries: Record<string, LinearMemberAgent | undefined>) => (id: string) => entries[id]

describe('linearMemberEligibility', () => {
  it('reads a placed org-visible agent as eligible whatever its daemon is doing', () => {
    // `routableDaemon` is placement ∪ confirmed holders, NOT liveness: a placed agent
    // on an offline daemon is still the member the compile routes to.
    expect(linearMemberEligibility(placed())).toBe('eligible')
  })

  it('reads a restricted agent as ineligible — no unscoped rung may name a gated agent', () => {
    expect(linearMemberEligibility(restricted())).toBe('ineligible')
  })

  it('reads an agent that is placed nowhere as ineligible', () => {
    expect(linearMemberEligibility(unplaced())).toBe('ineligible')
    // A set placement naming no set is the same "scope: none" the domain rule reports.
    expect(linearMemberEligibility(placed({ placementKind: 'set', setId: null, daemon: 'pool' }))).toBe('ineligible')
  })

  it('reads a set placement as unknown — the confirmed duty hold is not exposed here', () => {
    expect(linearMemberEligibility(onSet())).toBe('unknown')
  })

  it('reads a member it cannot resolve as unknown rather than as absent', () => {
    // Still loading, or an agent this viewer cannot see. Assuming it away is the one
    // direction that can delete the real default.
    expect(linearMemberEligibility(undefined)).toBe('unknown')
  })
})

describe('linearDefaultAgents', () => {
  it('takes the persisted pointer when it is eligible, and stops there', () => {
    const result = linearDefaultAgents(
      { preferredAgentId: 'b', agentIds: ['a', 'b'] },
      roster({ a: placed(), b: placed() })
    )
    expect(result).toEqual({ marked: 'b', candidates: ['b'] })
  })

  it('falls back to the earliest eligible member with no pointer set', () => {
    const result = linearDefaultAgents(
      { preferredAgentId: null, agentIds: ['a', 'b'] },
      roster({ a: placed(), b: placed() })
    )
    expect(result).toEqual({ marked: 'a', candidates: ['a'] })
  })

  it('ignores a pointer at a restricted agent, exactly as the compile does', () => {
    // `placed.find(p => p.agentId === preferred && !p.gated)` misses, so the fallback runs.
    const result = linearDefaultAgents(
      { preferredAgentId: 'a', agentIds: ['a', 'b'] },
      roster({ a: restricted(), b: placed() })
    )
    expect(result).toEqual({ marked: 'b', candidates: ['b'] })
  })

  it('ignores a pointer at an unplaced agent', () => {
    const result = linearDefaultAgents(
      { preferredAgentId: 'a', agentIds: ['a', 'b'] },
      roster({ a: unplaced(), b: placed() })
    )
    expect(result).toEqual({ marked: 'b', candidates: ['b'] })
  })

  it('ignores a pointer at an agent that is no longer a member', () => {
    const result = linearDefaultAgents({ preferredAgentId: 'gone', agentIds: ['a'] }, roster({ a: placed() }))
    expect(result).toEqual({ marked: 'a', candidates: ['a'] })
  })

  it('skips ineligible members when scanning for the fallback', () => {
    // THE REVIEW'S CASE: A is first (and would be marked by a membership-order read)
    // but is restricted, so B is the real default — and B is the one whose removal
    // must be refused.
    const result = linearDefaultAgents(
      { preferredAgentId: null, agentIds: ['a', 'b', 'c'] },
      roster({ a: restricted(), b: placed(), c: placed() })
    )
    expect(result).toEqual({ marked: 'b', candidates: ['b'] })
    expect(result.candidates).not.toContain('a')
  })

  it('leaves a workspace of only ineligible members with no default at all', () => {
    // The compile's own answer: a group of only gated agents has no fallback rung.
    const result = linearDefaultAgents(
      { preferredAgentId: 'a', agentIds: ['a', 'b'] },
      roster({ a: restricted(), b: unplaced() })
    )
    expect(result).toEqual({ marked: null, candidates: [] })
  })

  it('has no default on a workspace with no members', () => {
    expect(linearDefaultAgents({ preferredAgentId: null, agentIds: [] }, roster({}))).toEqual({
      marked: null,
      candidates: []
    })
  })
})

describe('linearDefaultAgents under an unknowable duty hold', () => {
  it('protects a set-placed member AND the eligible member behind it', () => {
    // A wins if its group has a confirmed holder; otherwise B does. The console cannot
    // tell, so neither may be removed until a definite default is named.
    const result = linearDefaultAgents(
      { preferredAgentId: null, agentIds: ['a', 'b'] },
      roster({ a: onSet(), b: placed() })
    )
    expect(result.marked).toBe('a')
    expect(result.candidates).toEqual(['a', 'b'])
  })

  it('stops collecting at the first definitely-eligible member', () => {
    // C can never win: B is eligible and earlier, so the scan ends there.
    const result = linearDefaultAgents(
      { preferredAgentId: null, agentIds: ['a', 'b', 'c'] },
      roster({ a: onSet(), b: placed(), c: onSet() })
    )
    expect(result.candidates).toEqual(['a', 'b'])
  })

  it('keeps an unknown pointer as the marked default and still protects the fallback', () => {
    const result = linearDefaultAgents(
      { preferredAgentId: 'c', agentIds: ['a', 'b', 'c'] },
      roster({ a: placed(), b: placed(), c: onSet() })
    )
    // The pointer might win; if it does not, the earliest eligible member does.
    expect(result.marked).toBe('c')
    expect(result.candidates).toEqual(['c', 'a'])
  })

  it('protects every member while the agent roster has not loaded', () => {
    const result = linearDefaultAgents({ preferredAgentId: null, agentIds: ['a', 'b'] }, roster({}))
    expect(result.candidates).toEqual(['a', 'b'])
  })

  it('collapses to one candidate once a definite default is named — the escape hatch', () => {
    // What the blocked-removal copy tells the operator to do.
    const members = { preferredAgentId: 'b', agentIds: ['a', 'b'] }
    expect(linearDefaultAgents(members, roster({ a: onSet(), b: placed() }))).toEqual({
      marked: 'b',
      candidates: ['b']
    })
  })
})
