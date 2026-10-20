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

const policy = ComputerPolicySchema.parse({
  allowedAgents: [AGENT_A, AGENT_B],
  leaseIdleSeconds: 120,
  leaseMaxSeconds: 1800
})
const computer = (over: Partial<LeaseComputer> = {}): LeaseComputer => ({
  status: 'online',
  lastSeenAt: new Date(T0),
  policy,
  ...over
})
const clock = (now = T0): LeaseClock => ({ now, holderTtlMs: 45_000, staleAfterMs: 45_000 })
const req = (sessionId: string, agentId = AGENT_A, leaseId = `lease-${sessionId}`) => ({
  sessionId,
  agentId,
  agentName: agentId === AGENT_A ? 'Ops' : null,
  daemonId: 'daemon-1',
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
    ...over
  }
}

describe('decideAcquire', () => {
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
      computer({ policy: { ...policy, allowedAgents: [AGENT_B] } }),
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

  it('ignores a turn end older than the lease', () => {
    const lease = held({ acquiredAt: T0 + 10_000 })
    expect(decideRelease(lease, { sessionId: 's1', agentId: AGENT_A, before: T0 }, 'session_ended').result).toBeNull()
    expect(
      decideRelease(lease, { sessionId: 's1', agentId: AGENT_A, before: T0 + 10_000 }, 'session_ended').result
    ).toMatchObject({ reason: 'session_ended' })
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
      { status: 'busy', lease: { holder: 's1', idleMs: 5_000 } },
      clock(T0 + 30_000)
    )
    expect(step.next).toMatchObject({ lastUsedAt: T0 + 25_000 })
  })

  it('ignores a report for another holder or an older input', () => {
    expect(
      decideObserve(computer(), held(), { status: 'busy', lease: { holder: 'local', idleMs: 0 } }, clock(T0 + 1000))
        .next
    ).toBeUndefined()
    expect(
      decideObserve(
        computer(),
        held({ lastUsedAt: T0 + 20_000 }),
        { status: 'busy', lease: { holder: 's1', idleMs: 15_000 } },
        clock(T0 + 30_000)
      ).next
    ).toBeUndefined()
  })

  it('clears a lease that ran out', () => {
    const step = decideObserve(computer(), held({ renewedAt: T0 + 200_000 }), { status: 'online' }, clock(T0 + 121_000))
    expect(step.result).toMatchObject({ lease: null, ended: { reason: 'idle' } })
  })
})

describe('decideRead and decidePreempt', () => {
  it('ends a lease whose grant the policy took away', () => {
    const revokedGrant = computer({ policy: { ...policy, allowedAgents: [AGENT_B] } })
    expect(decideRead(revokedGrant, held(), clock()).result).toMatchObject({ lease: null, ended: { reason: 'policy' } })
    expect(decideRead(computer(), held(), clock()).result).toEqual({ lease: held() })
    expect(decideRead(computer({ status: 'revoked' }), held(), clock()).result.ended?.reason).toBe('revoked')
  })

  it('pre-empts whoever holds the lease', () => {
    expect(decidePreempt(held(), 'revoked')).toMatchObject({ next: null, result: { reason: 'revoked' } })
    expect(decidePreempt(null, 'revoked')).toEqual({ next: undefined, result: null })
  })
})
