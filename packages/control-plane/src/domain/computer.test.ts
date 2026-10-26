import { describe, it, expect } from 'vitest'
import {
  ComputerAgentAccess,
  ComputerPolicySchema,
  agentAccessIsFixed,
  agentsAffectedByAccess,
  derivedComputerIds,
  readAgentAccess,
  defaultComputerPolicy,
  readComputerCapabilities,
  readComputerPolicy,
  withOwnerMember
} from './computer.js'

describe('ComputerPolicySchema', () => {
  it('fills the safe defaults from §4.1', () => {
    expect(ComputerPolicySchema.parse({})).toEqual({
      allowedMembers: [],
      agentMode: 'control',
      approvals: { firstInputPerSession: true },
      redactApps: [],
      exposeDriverTools: false,
      leaseIdleSeconds: 120,
      leaseMaxSeconds: 1800,
      leaseWaitSeconds: 45
    })
  })

  it('refuses an idle limit above the lease cap, a bad time zone and a malformed quiet range', () => {
    expect(ComputerPolicySchema.safeParse({ leaseIdleSeconds: 900, leaseMaxSeconds: 600 }).success).toBe(false)
    expect(
      ComputerPolicySchema.safeParse({ quietHours: { tz: 'Mars/Olympus', ranges: ['09:00-17:00'] } }).success
    ).toBe(false)
    expect(ComputerPolicySchema.safeParse({ quietHours: { tz: 'Asia/Shanghai', ranges: ['9-17'] } }).success).toBe(
      false
    )
    expect(
      ComputerPolicySchema.safeParse({ quietHours: { tz: 'Asia/Shanghai', ranges: ['09:00-17:30'] } }).success
    ).toBe(true)
  })

  it('accepts only agent ids shaped like agent ids in agent access', () => {
    expect(ComputerAgentAccess.safeParse({ mode: 'selected', agents: ['not-a-uuid'] }).success).toBe(false)
  })
})

describe('policy helpers', () => {
  it('a new Computer admits only its owner as a member and no agent', () => {
    const p = defaultComputerPolicy('u1')
    expect(p.allowedMembers).toEqual(['u1'])
    expect(p).not.toHaveProperty('allowedAgents')
  })

  it('keeps the owner first and once among the allowed members', () => {
    const p = withOwnerMember(ComputerPolicySchema.parse({ allowedMembers: ['u2', 'u1'] }), 'u1')
    expect(p.allowedMembers).toEqual(['u1', 'u2'])
  })

  it('reads an unreadable stored policy or capability blob as the defaults instead of failing', () => {
    expect(readComputerPolicy({ leaseIdleSeconds: 'x' }, 'u1')).toEqual(defaultComputerPolicy('u1'))
    expect(readComputerCapabilities(null)).toMatchObject({ screenshot: false, displays: [], textInput: 'full' })
  })
})

describe('agent access (§4.1)', () => {
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

  it('reads stored columns, an unknown mode as none and an empty selection as none', () => {
    expect(readAgentAccess('selected', [A, A])).toEqual({ mode: 'selected', agents: [A] })
    expect(readAgentAccess('selected', [])).toEqual({ mode: 'none', agents: [] })
    expect(readAgentAccess('all', [A])).toEqual({ mode: 'all', agents: [] })
    expect(readAgentAccess('bogus', [A])).toEqual({ mode: 'none', agents: [] })
  })

  it('names the agents a change moves, or every agent when All is on either side', () => {
    const none = { mode: 'none' as const, agents: [] }
    expect(agentsAffectedByAccess(none, { mode: 'selected', agents: [A] })).toEqual([A])
    expect(agentsAffectedByAccess({ mode: 'selected', agents: [A] }, { mode: 'selected', agents: [B] })).toEqual([A, B])
    expect(agentsAffectedByAccess({ mode: 'selected', agents: [A] }, { mode: 'selected', agents: [A] })).toEqual([])
    expect(agentsAffectedByAccess(none, { mode: 'all', agents: [] })).toBe('all')
    expect(agentsAffectedByAccess({ mode: 'all', agents: [] }, none)).toBe('all')
    expect(agentsAffectedByAccess({ mode: 'all', agents: [] }, { mode: 'all', agents: [] })).toEqual([])
  })

  it('derives an agent’s Computers from every grant that admits it, in grant order', () => {
    const grants = [
      { id: 'c1', agentAccess: { mode: 'selected' as const, agents: [A] } },
      { id: 'c2', agentAccess: { mode: 'all' as const, agents: [] } },
      { id: 'c3', agentAccess: { mode: 'selected' as const, agents: [B] } }
    ]
    expect(derivedComputerIds(grants, A)).toEqual(['c1', 'c2'])
    expect(derivedComputerIds(grants, B)).toEqual(['c2', 'c3'])
  })

  it('fixes the access of a per-agent or ephemeral computer to its own agent', () => {
    expect(agentAccessIsFixed({ allocation: 'per-agent' })).toBe(true)
    expect(agentAccessIsFixed({ allocation: 'ephemeral' })).toBe(true)
    expect(agentAccessIsFixed({ allocation: 'manual' })).toBe(false)
    expect(agentAccessIsFixed({ allocation: null })).toBe(false)
  })
})
