import { describe, expect, it } from 'vitest'
import { ComputerPolicySchema } from './computer.js'
import {
  decideAcquire,
  decideObserve,
  decidePreempt,
  decideRead,
  decideRelease,
  leaseDeadline,
  type ControlLease,
  type LeaseClock,
  type LeaseComputer
} from './computerLease.js'

const T0 = 1_760_000_000_000
const CID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const AGENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const AGENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
// The holder name a desktop reports for session s1 of agent A.
const S1_HOLDER = `${AGENT_A}/s1`

const policy = ComputerPolicySchema.parse({
  leaseIdleSeconds: 120,
  leaseMaxSeconds: 1800
})
const computer = (over: Partial<LeaseComputer> = {}): LeaseComputer => ({
  status: 'online',
  lastSeenAt: new Date(T0),
  policy,
  agentAccess: { mode: 'selected', agents: [AGENT_A, AGENT_B] },
  ...over
})
const clock = (now = T0): LeaseClock => ({ now, holderTtlMs: 45_000, staleAfterMs: 45_000 })
const req = (sessionId: string, agentId = AGENT_A, leaseId = `lease-${sessionId}`) => ({
  sessionId,
  agentId,
  agentName: agentId === AGENT_A ? 'Ops' : null,
  daemonId: 'daemon-1',
  turnAt: T0,
  leaseId
})

function held(over: Partial<ControlLease> = {}): ControlLease {
  return {
    leaseId: 'lease-1',
    computerId: CID,
    orgId: 'org_1',
    sessionId: 's1',
    agentId: AGENT_A,
    agentName: 'Ops',
    daemonId: 'daemon-1',
    acquiredAt: T0,
    lastUsedAt: T0,
    renewedAt: T0,
    turnAt: T0,
    spentAt: null,
    ...over
  }
}

describe('decideAcquire', () => {
  it('refuses while a console Stop stands, and a read ends the lease it finds', () => {
    const stopped = computer({ stoppedAt: new Date(T0) })
    expect(decideAcquire(CID, 'org_1', stopped, null, req('s1'), clock()).result).toMatchObject({
      granted: false,
      code: 'human_in_control'
    })
    expect(decideRead(stopped, held(), clock()).next).toBeNull()
  })

  it('grants a free Computer to a granted agent and stamps every clock', () => {
    const step = decideAcquire(CID, 'org_1', computer(), null, req('s1'), clock())
    expect(step.result).toMatchObject({ granted: true, fresh: true })
    expect(step.next).toMatchObject({
      sessionId: 's1',
      acquiredAt: T0,
      lastUsedAt: T0,
      renewedAt: T0,
      leaseId: 'lease-s1'
    })
  })

  it('renews the same session in place, keeping its lease id and acquisition time', () => {
    const now = T0 + 60_000
    const live = computer({ lastSeenAt: new Date(now) })
    const step = decideAcquire(
      CID,
      'org_1',
      live,
      held({ renewedAt: T0 + 50_000 }),
      req('s1', AGENT_A, 'other'),
      clock(now)
    )
    expect(step.result).toMatchObject({ granted: true, fresh: false })
    expect(step.next).toMatchObject({ leaseId: 'lease-1', acquiredAt: T0, lastUsedAt: now, renewedAt: now })
  })

  it('refuses another session with computer_busy naming the holder', () => {
    const step = decideAcquire(CID, 'org_1', computer(), held(), req('s2', AGENT_B), clock(T0 + 1000))
    expect(step.next).toBeUndefined()
    expect(step.result).toEqual({
      granted: false,
      code: 'computer_busy',
      message: 'this computer is controlled by Ops',
      holder: { sessionId: 's1', agentId: AGENT_A, agentName: 'Ops' }
    })
  })

  it('treats the same session id under another agent as another holder', () => {
    const step = decideAcquire(CID, 'org_1', computer(), held(), req('s1', AGENT_B), clock())
    expect(step.result).toMatchObject({ granted: false, code: 'computer_busy' })
  })

  it.each([
    ['idle', T0 + 120_000, { renewedAt: T0 + 100_000 }],
    ['max', T0 + 1_800_000, { lastUsedAt: T0 + 1_790_000, renewedAt: T0 + 1_790_000 }],
    ['holder_lost', T0 + 45_000, { lastUsedAt: T0 + 40_000 }]
  ] as const)('replaces a lease that ran out (%s)', (reason, now, over) => {
    const step = decideAcquire(
      CID,
      'org_1',
      computer({ lastSeenAt: new Date(now) }),
      held(over),
      req('s2', AGENT_B),
      clock(now)
    )
    expect(step.result).toMatchObject({ granted: true, fresh: true, replaced: { reason } })
    expect(step.next).toMatchObject({ sessionId: 's2', leaseId: 'lease-s2' })
  })

  it('refuses an agent the policy does not grant, or a view-only policy', () => {
    const notGranted = decideAcquire(
      CID,
      'org_1',
      computer({ agentAccess: { mode: 'selected', agents: [AGENT_B] } }),
      null,
      req('s1'),
      clock()
    )
    expect(notGranted.result).toMatchObject({ granted: false, code: 'denied' })
    const viewOnly = decideAcquire(
      CID,
      'org_1',
      computer({ policy: { ...policy, agentMode: 'view' } }),
      null,
      req('s1'),
      clock()
    )
    expect(viewOnly.result).toMatchObject({ granted: false, code: 'denied' })
  })

  it('refuses a paused or taken-over Computer with human_in_control', () => {
    for (const status of ['paused', 'human_in_control'] as const) {
      const step = decideAcquire(CID, 'org_1', computer({ status }), null, req('s1'), clock())
      expect(step.result).toMatchObject({ granted: false, code: 'human_in_control' })
    }
  })

  it('refuses an offline, stale, revoked or missing Computer with unavailable', () => {
    const cases: Array<LeaseComputer | null> = [
      computer({ status: 'offline' }),
      computer({ lastSeenAt: new Date(T0 - 46_000) }),
      computer({ status: 'revoked' }),
      null
    ]
    for (const c of cases) {
      expect(decideAcquire(CID, 'org_1', c, null, req('s1'), clock()).result).toMatchObject({
        granted: false,
        code: 'unavailable'
      })
    }
  })

  it('does not count the desktop reporting busy as a refusal', () => {
    const step = decideAcquire(CID, 'org_1', computer({ status: 'busy' }), null, req('s1'), clock())
    expect(step.result).toMatchObject({ granted: true })
  })
})

describe('leaseDeadline', () => {
  it('is the earliest of idle, max and holder liveness', () => {
    expect(leaseDeadline(held(), policy, 45_000)).toEqual({ at: T0 + 45_000, reason: 'holder_lost' })
    expect(leaseDeadline(held({ renewedAt: T0 + 100_000 }), policy, 45_000)).toEqual({
      at: T0 + 120_000,
      reason: 'idle'
    })
    expect(leaseDeadline(held({ lastUsedAt: T0 + 1_799_000, renewedAt: T0 + 1_799_000 }), policy, 45_000)).toEqual({
      at: T0 + 1_800_000,
      reason: 'max'
    })
  })
})

describe('decideRelease', () => {
  it('releases only the holder session', () => {
    expect(decideRelease(held(), { sessionId: 's2', agentId: AGENT_A }, 'released')).toEqual({
      next: undefined,
      result: null
    })
    expect(decideRelease(null, { sessionId: 's1', agentId: AGENT_A }, 'released').result).toBeNull()
    const step = decideRelease(held(), { sessionId: 's1', agentId: AGENT_A }, 'released')
    expect(step.next).toBeNull()
    expect(step.result).toMatchObject({ reason: 'released', ended: { leaseId: 'lease-1' } })
  })

  it('ignores a turn end stamped before the latest acquire on the daemon clock', () => {
    const lease = held({ turnAt: T0 + 10_000 })
    expect(decideRelease(lease, { sessionId: 's1', agentId: AGENT_A, before: T0 }, 'session_ended').result).toBeNull()
    expect(
      decideRelease(lease, { sessionId: 's1', agentId: AGENT_A, before: T0 + 10_000 }, 'session_ended').result
    ).toMatchObject({ reason: 'session_ended' })
  })
})

describe('the max limit', () => {
  const capped = T0 + 1_800_000
  const used = held({ lastUsedAt: capped - 1000, renewedAt: capped - 1000 })

  it('refuses the same session right after the max deadline and marks the lease spent', () => {
    const step = decideAcquire(CID, 'org_1', computer({ lastSeenAt: new Date(capped) }), used, req('s1'), clock(capped))
    expect(step.result).toMatchObject({ granted: false, code: 'denied', ended: { reason: 'max' } })
    expect(step.next).toMatchObject({ leaseId: 'lease-1', spentAt: capped })
  })

  it('keeps refusing the spent session but lets another session take the Computer', () => {
    const spent = held({ ...used, spentAt: capped, renewedAt: capped + 5000 })
    const live = computer({ lastSeenAt: new Date(capped + 10_000) })
    const again = decideAcquire(CID, 'org_1', live, spent, req('s1'), clock(capped + 10_000))
    expect(again).toMatchObject({ next: undefined, result: { granted: false, code: 'denied' } })
    expect(again.result).not.toHaveProperty('ended')
    const other = decideAcquire(CID, 'org_1', live, spent, req('s2', AGENT_B), clock(capped + 10_000))
    expect(other.result).toMatchObject({ granted: true, fresh: true })
    expect(other.result).not.toHaveProperty('replaced')
  })

  it('reads a spent row as no lease, keeps it through a release and a stop, and clears it at the turn end', () => {
    const spent = held({ ...used, spentAt: capped, renewedAt: capped })
    expect(decideRead(computer(), spent, clock(capped + 1000))).toEqual({ next: undefined, result: { lease: null } })
    expect(decideObserve(computer(), spent, { status: 'online' }, clock(capped + 1000)).result).toEqual({ lease: null })
    expect(decideRelease(spent, { sessionId: 's1', agentId: AGENT_A }, 'released')).toEqual({
      next: undefined,
      result: null
    })
    expect(decidePreempt(spent, 'paused')).toEqual({ next: undefined, result: null })
    expect(decideRelease(spent, { sessionId: 's1', agentId: AGENT_A, before: capped }, 'session_ended')).toEqual({
      next: null,
      result: null
    })
  })

  it('stops barring the session once its daemon is lost or another max period passes', () => {
    const spent = held({ ...used, spentAt: capped, renewedAt: capped })
    expect(decideRead(computer(), spent, clock(capped + 45_000)).next).toBeNull()
    const beating = held({ ...spent, renewedAt: capped + 1_800_000 })
    expect(decideRead(computer(), beating, clock(capped + 1_800_000)).next).toBeNull()
  })

  it('marks a lease spent when a read finds it at the max limit', () => {
    const step = decideRead(computer(), used, clock(capped))
    expect(step).toMatchObject({ next: { spentAt: capped }, result: { lease: null, ended: { reason: 'max' } } })
  })
})

describe('decideObserve', () => {
  it('pre-empts the lease on a pause or a takeover', () => {
    expect(decideObserve(computer(), held(), { status: 'paused' }, clock()).result).toMatchObject({
      lease: null,
      ended: { reason: 'paused' }
    })
    const takeover = decideObserve(computer(), held(), { status: 'human_in_control' }, clock())
    expect(takeover.next).toBeNull()
    expect(takeover.result.ended?.reason).toBe('human_takeover')
  })

  it("moves the idle clock to the holder's last input on the desktop", () => {
    const step = decideObserve(
      computer(),
      held(),
      { status: 'busy', lease: { holder: S1_HOLDER, idleMs: 5_000 } },
      clock(T0 + 30_000)
    )
    expect(step.next).toMatchObject({ lastUsedAt: T0 + 25_000 })
  })

  it('ignores a report for another holder or an older input', () => {
    expect(
      decideObserve(computer(), held(), { status: 'busy', lease: { holder: 'local', idleMs: 0 } }, clock(T0 + 1000))
        .next
    ).toBeUndefined()
    // The same session id under another agent is another holder.
    expect(
      decideObserve(
        computer(),
        held(),
        { status: 'busy', lease: { holder: `${AGENT_B}/s1`, idleMs: 0 } },
        clock(T0 + 1000)
      ).next
    ).toBeUndefined()
    expect(
      decideObserve(
        computer(),
        held({ lastUsedAt: T0 + 20_000 }),
        { status: 'busy', lease: { holder: S1_HOLDER, idleMs: 15_000 } },
        clock(T0 + 30_000)
      ).next
    ).toBeUndefined()
  })

  it('counts input reported in the heartbeat that reaches the idle deadline', () => {
    const lease = held({ renewedAt: T0 + 110_000 })
    const step = decideObserve(
      computer(),
      lease,
      { status: 'busy', lease: { holder: S1_HOLDER, idleMs: 2_000 } },
      clock(T0 + 120_000)
    )
    expect(step).toMatchObject({ next: { lastUsedAt: T0 + 118_000 }, result: { lease: { lastUsedAt: T0 + 118_000 } } })
  })

  it('counts continuous input between heartbeats that passes the stale idle deadline', () => {
    // A 10 s idle limit, input every second through t=14 s, and the heartbeat at t=15 s.
    const short = computer({ policy: { ...policy, leaseIdleSeconds: 10 } })
    const report = { status: 'busy' as const, lease: { holder: S1_HOLDER, idleMs: 1_000, heldMs: 15_000 } }
    const step = decideObserve(short, held(), report, clock(T0 + 15_000))
    expect(step).toMatchObject({ next: { lastUsedAt: T0 + 14_000 }, result: { lease: { lastUsedAt: T0 + 14_000 } } })
  })

  it('does not count a desktop lease taken again after this one ran out idle', () => {
    const lease = held({ renewedAt: T0 + 120_000 })
    const report = { status: 'busy' as const, lease: { holder: S1_HOLDER, idleMs: 1_000, heldMs: 3_000 } }
    expect(decideObserve(computer(), lease, report, clock(T0 + 125_000)).result).toMatchObject({
      lease: null,
      ended: { reason: 'idle' }
    })
  })

  it('does not revive a lease with input made after it already ran out idle', () => {
    const lease = held({ renewedAt: T0 + 120_000 })
    const step = decideObserve(
      computer(),
      lease,
      { status: 'busy', lease: { holder: S1_HOLDER, idleMs: 0 } },
      clock(T0 + 125_000)
    )
    expect(step.result).toMatchObject({ lease: null, ended: { reason: 'idle' } })
  })

  it('clears a lease that ran out', () => {
    const step = decideObserve(computer(), held({ renewedAt: T0 + 200_000 }), { status: 'online' }, clock(T0 + 121_000))
    expect(step.result).toMatchObject({ lease: null, ended: { reason: 'idle' } })
  })
})

describe('decideRead and decidePreempt', () => {
  it('ends a lease whose grant the policy took away', () => {
    const revokedGrant = computer({ agentAccess: { mode: 'selected', agents: [AGENT_B] } })
    expect(decideRead(revokedGrant, held(), clock()).result).toMatchObject({ lease: null, ended: { reason: 'policy' } })
    expect(decideRead(computer(), held(), clock()).result).toEqual({ lease: held() })
    expect(decideRead(computer({ status: 'revoked' }), held(), clock()).result.ended?.reason).toBe('revoked')
  })

  it('pre-empts whoever holds the lease', () => {
    expect(decidePreempt(held(), 'revoked')).toMatchObject({ next: null, result: { reason: 'revoked' } })
    expect(decidePreempt(null, 'revoked')).toEqual({ next: undefined, result: null })
  })
})
