import { describe, expect, it } from 'vitest'
import { ComputerPolicySchema } from './computer.js'
import {
  LEASE_WAITER_TTL_MS,
  dropWaiter,
  endedWait,
  joinQueue,
  keepWaiters,
  waitersAhead,
  type LeaseWaiter
} from './computerLeaseQueue.js'

const T0 = 1_760_000_000_000
const CID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const AGENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const AGENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const policy = ComputerPolicySchema.parse({ allowedAgents: [AGENT_A, AGENT_B] })

const waiter = (sessionId: string, over: Partial<LeaseWaiter> = {}): LeaseWaiter => ({
  computerId: CID,
  orgId: 'org_1',
  sessionId,
  agentId: AGENT_A,
  daemonId: 'daemon-1',
  enqueuedAt: T0,
  polledAt: T0,
  turnAt: T0,
  droppedAt: null,
  ...over
})
const ask = (sessionId: string, agentId = AGENT_A, turnAt = T0) => ({
  sessionId,
  agentId,
  daemonId: 'daemon-1',
  turnAt
})

describe('the lease wait queue', () => {
  it('orders by arrival, breaking ties the same way on every replica', () => {
    const queue = keepWaiters(
      [
        waiter('late', { enqueuedAt: T0 + 2 }),
        waiter('b', { agentId: AGENT_B }),
        waiter('a'),
        waiter('gone', { enqueuedAt: T0 - 1, droppedAt: T0 })
      ],
      policy,
      T0
    )
    expect(queue.map((w) => w.sessionId)).toEqual(['gone', 'a', 'b', 'late'])
    // A dropped entry holds no place.
    expect(waitersAhead(queue, queue[3])).toBe(2)
    expect(waitersAhead(queue, undefined)).toBe(3)
  })

  it('lets a waiter that stopped asking or lost its grant leave', () => {
    const queue = [waiter('quiet'), waiter('asking', { polledAt: T0 + 10_000 }), waiter('b', { agentId: AGENT_B })]
    const now = T0 + LEASE_WAITER_TTL_MS
    expect(keepWaiters(queue, policy, now).map((w) => w.sessionId)).toEqual(['asking'])
    const viewOnly = ComputerPolicySchema.parse({ allowedAgents: [AGENT_A, AGENT_B], agentMode: 'view' })
    expect(keepWaiters(queue, viewOnly, T0)).toEqual([])
    expect(keepWaiters(queue, ComputerPolicySchema.parse({ allowedAgents: [AGENT_B] }), T0)).toHaveLength(1)
  })

  it('keeps a place across asks and times out after leaseWaitSeconds', () => {
    const first = joinQueue(CID, 'org_1', [waiter('ahead')], ask('s2', AGENT_B), policy, T0 + 1)
    expect(first).toMatchObject({ kind: 'waiting', queued: { position: 2, waitedMs: 0, leftMs: 45_000 } })
    const again = joinQueue(CID, 'org_1', first.queue, ask('s2', AGENT_B, T0 + 5), policy, T0 + 30_001)
    expect(again).toMatchObject({ kind: 'waiting', queued: { position: 2, waitedMs: 30_000, leftMs: 15_000 } })
    expect(again.queue.find((w) => w.sessionId === 's2')).toMatchObject({ enqueuedAt: T0 + 1, turnAt: T0 + 5 })
    const late = joinQueue(CID, 'org_1', again.queue, ask('s2', AGENT_B), policy, T0 + 45_001)
    expect(late).toMatchObject({ kind: 'timed_out', waitedMs: 45_000 })
    expect(late.queue.map((w) => w.sessionId)).toEqual(['ahead'])
  })

  it('drops a wait only for a turn end stamped at or after its latest ask', () => {
    const queue = [waiter('s1', { turnAt: T0 + 5 })]
    expect(dropWaiter(queue, ask('s1'), T0 + 4, T0)).toBeUndefined()
    const dropped = dropWaiter(queue, ask('s1'), T0 + 5, T0 + 9)!
    expect(dropped[0]).toMatchObject({ droppedAt: T0 + 9, polledAt: T0 + 9 })
    expect(endedWait(dropped, ask('s1', AGENT_A, T0 + 5))).toBeDefined()
    // The next turn's ask is a new wait.
    expect(endedWait(dropped, ask('s1', AGENT_A, T0 + 6))).toBeUndefined()
    const rejoined = joinQueue(CID, 'org_1', dropped, ask('s1', AGENT_A, T0 + 6), policy, T0 + 10)
    expect(rejoined.queue).toEqual([expect.objectContaining({ enqueuedAt: T0 + 10, droppedAt: null })])
  })
})
