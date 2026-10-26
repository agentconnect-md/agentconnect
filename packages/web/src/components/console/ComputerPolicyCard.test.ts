import { describe, expect, it } from 'vitest'
import type { ComputerPolicy } from '@agentconnect.md/protocol/computer'
import { draftOf, policyFromDraft } from './ComputerPolicyCard'

const policy: ComputerPolicy = {
  allowedMembers: ['u1'],
  agentMode: 'control',
  approvals: { firstInputPerSession: true },
  redactApps: ['1password'],
  exposeDriverTools: false,
  quietHours: { tz: 'UTC', ranges: ['22:00-07:00'] },
  leaseIdleSeconds: 120,
  leaseMaxSeconds: 1800,
  leaseWaitSeconds: 45,
  screenshotRetentionDays: 7
}

describe('the policy form', () => {
  it('round-trips a policy and keeps the fields it does not edit', () => {
    const result = policyFromDraft(policy, draftOf(policy))
    expect(result).toEqual({ policy })
  })

  it('keeps the administrator prompt mode the taskbar set, and stores a change made here', () => {
    const windows = { ...policy, approvals: { firstInputPerSession: true, adminPrompts: 'agent' as const } }
    expect(policyFromDraft(windows, draftOf(windows))).toEqual({ policy: windows })
    const denied = policyFromDraft(policy, { ...draftOf(policy), adminPrompts: 'deny' })
    expect('policy' in denied && denied.policy.approvals).toEqual({ firstInputPerSession: true, adminPrompts: 'deny' })
  })

  it('drops the retention when blanked, so the deployment default applies', () => {
    const result = policyFromDraft(policy, { ...draftOf(policy), screenshotRetentionDays: ' ' })
    expect('policy' in result && result.policy.screenshotRetentionDays).toBeUndefined()
    expect('policy' in result && result.policy.quietHours).toEqual(policy.quietHours)
  })

  it('shows peer-to-peer viewing on for an owner-only Computer and stores it only once changed', () => {
    const owner = { ownerUserId: 'u1', kind: 'self-hosted' as const }
    const draft = draftOf(policy, owner)
    expect(draft.viewerPeerToPeer).toBe(true)
    expect(policyFromDraft(policy, draft, owner)).toEqual({ policy })
    const off = policyFromDraft(policy, { ...draft, viewerPeerToPeer: false }, owner)
    expect('policy' in off && off.policy.viewerPeerToPeer).toBe(false)
    const shared = { ...policy, allowedMembers: ['u1', 'u2'] }
    expect(draftOf(shared, owner).viewerPeerToPeer).toBe(false)
    const on = policyFromDraft(shared, { ...draftOf(shared, owner), viewerPeerToPeer: true }, owner)
    expect('policy' in on && on.policy.viewerPeerToPeer).toBe(true)
  })

  it('drops a stored setting once toggled back to the default, so sharing later still turns it off', () => {
    const owner = { ownerUserId: 'u1', kind: 'self-hosted' as const }
    const stored = { ...policy, viewerPeerToPeer: false }
    const result = policyFromDraft(stored, { ...draftOf(stored, owner), viewerPeerToPeer: true }, owner)
    expect('policy' in result && 'viewerPeerToPeer' in result.policy).toBe(false)
  })

  it('defaults peer-to-peer viewing off for a managed Computer, whose editors may watch too', () => {
    const owner = { ownerUserId: 'u1', kind: 'managed' as const }
    expect(draftOf(policy, owner).viewerPeerToPeer).toBe(false)
    const on = policyFromDraft(policy, { ...draftOf(policy, owner), viewerPeerToPeer: true }, owner)
    expect('policy' in on && on.policy.viewerPeerToPeer).toBe(true)
  })

  it('refuses out-of-range or inconsistent limits the way the Control Plane would', () => {
    const draft = draftOf(policy)
    expect(policyFromDraft(policy, { ...draft, leaseIdleSeconds: '5' })).toEqual({ problem: 'idleRange' })
    expect(policyFromDraft(policy, { ...draft, leaseMaxSeconds: '1.5' })).toEqual({ problem: 'maxRange' })
    expect(policyFromDraft(policy, { ...draft, leaseIdleSeconds: '600', leaseMaxSeconds: '300' })).toEqual({
      problem: 'idleAboveMax'
    })
    expect(policyFromDraft(policy, { ...draft, leaseWaitSeconds: '601' })).toEqual({ problem: 'waitRange' })
    expect(policyFromDraft(policy, { ...draft, leaseWaitSeconds: '0' })).toMatchObject({
      policy: { leaseWaitSeconds: 0 }
    })
    expect(policyFromDraft(policy, { ...draft, screenshotRetentionDays: '-1' })).toEqual({ problem: 'retentionRange' })
  })
})
