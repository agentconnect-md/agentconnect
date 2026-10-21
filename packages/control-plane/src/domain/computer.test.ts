import { describe, it, expect } from 'vitest'
import {
  ComputerPolicySchema,
  defaultComputerPolicy,
  readComputerCapabilities,
  readComputerPolicy,
  withOwnerMember
} from './computer.js'

describe('ComputerPolicySchema', () => {
  it('fills the safe defaults from §4.1', () => {
    expect(ComputerPolicySchema.parse({})).toEqual({
      allowedAgents: [],
      allowedMembers: [],
      agentMode: 'control',
      approvals: { firstInputPerSession: true, launchApp: 'always', submitLikeKeys: true },
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

  it('accepts only agent ids shaped like agent ids', () => {
    expect(ComputerPolicySchema.safeParse({ allowedAgents: ['not-a-uuid'] }).success).toBe(false)
  })
})

describe('policy helpers', () => {
  it('a new Computer admits only its owner as a member and no agent', () => {
    const p = defaultComputerPolicy('u1')
    expect(p.allowedMembers).toEqual(['u1'])
    expect(p.allowedAgents).toEqual([])
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
