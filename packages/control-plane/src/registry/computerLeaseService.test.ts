import { describe, expect, it } from 'vitest'
import type { ComputerControlLease } from '@agentconnect.md/protocol'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { ComputerPolicySchema } from '../domain/computer.js'
import type { ControlLease, LeaseComputer, LeaseStep } from '../domain/computerLease.js'
import type { LeaseWaiter } from '../domain/computerLeaseQueue.js'
import type { ComputerId, OrgId } from '../domain/ids.js'
import type { ComputerLeaseRepo } from '../persistence/ports.js'
import { ComputerLeaseService, wireLease } from './computerLeaseService.js'

const T0 = 1_760_000_000_000
const ORG = 'org_1'
const CID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const AGENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const AGENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
// The holder name a desktop reports for session s1 of agent A.
const S1_HOLDER = `${AGENT_A}/s1`

class MemoryLeaseRepo implements ComputerLeaseRepo {
  leases = new Map<string, ControlLease>()
  computers = new Map<string, LeaseComputer & { orgId: string }>()
  queues = new Map<string, LeaseWaiter[]>()

  async get(computerId: ComputerId) {
    return this.leases.get(computerId) ?? null
  }
  async step<R>(
    orgId: OrgId,
    computerId: ComputerId,
    decide: (c: LeaseComputer | null, l: ControlLease | null, q: LeaseWaiter[]) => LeaseStep<R>
  ) {
    const computer = this.computers.get(computerId)
    const visible = computer && computer.orgId === orgId ? computer : null
    const { next, queue, result } = decide(
      visible,
      visible ? (this.leases.get(computerId) ?? null) : null,
      visible ? [...(this.queues.get(computerId) ?? [])] : []
    )
    if (next === null) this.leases.delete(computerId)
    if (next) this.leases.set(computerId, next)
    if (queue) this.queues.set(computerId, queue)
    return result
  }
  async listBySession(sessionId: string) {
    return [...this.leases.values()].filter((l) => l.sessionId === sessionId)
  }
  async listWaitingBySession(sessionId: string) {
    return [...this.queues.values()].flat().filter((w) => w.sessionId === sessionId)
  }
  async listOccupancy(ids: readonly ComputerId[]) {
    return {
      leases: [...this.leases.values()].filter((l) => ids.includes(l.computerId as ComputerId)),
      waiters: ids.flatMap((id) => this.queues.get(id) ?? []).filter((w) => w.droppedAt === null)
    }
  }
  async renewByDaemon(daemonId: string, at: Date, aliveSince: Date) {
    let n = 0
    for (const lease of this.leases.values()) {
      if (lease.daemonId !== daemonId || lease.renewedAt <= aliveSince.getTime()) continue
      lease.renewedAt = at.getTime()
      n++
    }
    return n
  }
}

function setup() {
  const clock = new FakeClock(T0)
  const repo = new MemoryLeaseRepo()
  repo.computers.set(CID, {
    orgId: ORG,
    status: 'online',
    lastSeenAt: new Date(T0),
    policy: ComputerPolicySchema.parse({}),
    agentAccess: { mode: 'selected', agents: [AGENT_A, AGENT_B] }
  })
  const pushed: Array<ComputerControlLease | null> = []
  // The connection re-reads the lease on a change; the in-memory repo has committed by then.
  const service: ComputerLeaseService = new ComputerLeaseService(repo, clock, {
    holderTtlMs: 45_000,
    staleAfterMs: 45_000,
    channels: {
      leaseChanged: () => {
        const lease = repo.leases.get(CID)
        pushed.push(lease && lease.spentAt === null ? wireLease(lease, repo.computers.get(CID)!.policy) : null)
      }
    }
  })
  // The desktop keeps beating, so the Computer stays online as the fake clock moves.
  const tick = (ms: number) => {
    clock.advance(ms)
    repo.computers.get(CID)!.lastSeenAt = new Date(clock.now())
  }
  return { clock, repo, service, pushed, tick }
}

const who = (sessionId: string, agentId = AGENT_A) => ({
  sessionId,
  agentId,
  agentName: agentId === AGENT_A ? 'Ops' : 'Review',
  daemonId: 'daemon-1',
  turnAt: T0
})

describe('ComputerLeaseService', () => {
  it('grants once, tells the desktop, and names the holder to anyone else', async () => {
    const { service, pushed } = setup()
    const first = await service.acquire(ORG, CID, who('s1'))
    expect(first).toMatchObject({ granted: true, fresh: true, view: { holder: { sessionId: 's1', agentName: 'Ops' } } })
    expect(first.granted && first.view.expiresAt).toBe(new Date(T0 + 1_800_000).toISOString())
    const again = await service.acquire(ORG, CID, who('s1'))
    expect(again).toMatchObject({ granted: true, fresh: false })
    expect(pushed).toHaveLength(1)
    const other = await service.acquire(ORG, CID, who('s2', AGENT_B))
    expect(other).toMatchObject({
      granted: false,
      code: 'computer_busy',
      holder: { sessionId: 's1', agentName: 'Ops' }
    })
  })

  it('releases for the holder only and tells the desktop', async () => {
    const { service, pushed } = setup()
    await service.acquire(ORG, CID, who('s1'))
    expect(await service.release(ORG, CID, { sessionId: 's2', agentId: AGENT_A })).toBe(false)
    expect(await service.release(ORG, CID, { sessionId: 's1', agentId: AGENT_A })).toBe(true)
    expect(pushed.at(-1)).toBeNull()
    expect(await service.acquire(ORG, CID, who('s2', AGENT_B))).toMatchObject({ granted: true })
  })

  it('releases every lease a session took before its turn ended', async () => {
    const { service, repo, pushed } = setup()
    await service.acquire(ORG, CID, who('s1'))
    expect(await service.sessionEnded('s1', AGENT_B, T0)).toBe(0)
    expect(await service.sessionEnded('s1', AGENT_A, T0 - 1)).toBe(0)
    expect(await service.sessionEnded('s1', AGENT_A, T0)).toBe(1)
    expect(repo.leases.size).toBe(0)
    expect(pushed.at(-1)).toBeNull()
  })

  it('keeps a lease alive while its daemon beats and lets it lapse once the daemon goes quiet', async () => {
    const { service, tick } = setup()
    await service.acquire(ORG, CID, who('s1'))
    for (let i = 0; i < 3; i++) {
      tick(15_000)
      // The desktop reports the session's input, so the idle limit is not what ends it here.
      await service.observe(ORG, CID, { status: 'busy', lease: { holder: S1_HOLDER, idleMs: 0 } })
      expect(await service.daemonHeartbeat('daemon-1')).toBe(1)
    }
    tick(30_000)
    expect(await service.current(ORG, CID)).toMatchObject({ holder: { sessionId: 's1' } })
    tick(16_000)
    // A late beat cannot bring a lost holder back.
    expect(await service.daemonHeartbeat('daemon-1')).toBe(0)
    expect(await service.current(ORG, CID)).toBeNull()
  })

  it('runs out after the idle limit even while the daemon beats', async () => {
    const { service, tick } = setup()
    await service.acquire(ORG, CID, who('s1'))
    for (let elapsed = 0; elapsed < 120_000; elapsed += 15_000) {
      tick(15_000)
      await service.daemonHeartbeat('daemon-1')
    }
    expect(await service.current(ORG, CID)).toBeNull()
  })

  it('stops at the max limit even with constant use', async () => {
    const { service, tick } = setup()
    await service.acquire(ORG, CID, who('s1'))
    for (let elapsed = 0; elapsed < 1_800_000; elapsed += 15_000) {
      tick(15_000)
      await service.observe(ORG, CID, { status: 'busy', lease: { holder: S1_HOLDER, idleMs: 0 } })
      await service.daemonHeartbeat('daemon-1')
    }
    expect(await service.current(ORG, CID)).toBeNull()
    expect(await service.acquire(ORG, CID, who('s2', AGENT_B))).toMatchObject({ granted: true, fresh: true })
  })

  it('does not let the session that hit the max limit take the Computer again until its turn ends', async () => {
    const { service, tick, repo } = setup()
    await service.acquire(ORG, CID, who('s1'))
    for (let elapsed = 0; elapsed < 1_800_000; elapsed += 15_000) {
      tick(15_000)
      await service.acquire(ORG, CID, who('s1'))
    }
    expect(await service.acquire(ORG, CID, who('s1'))).toMatchObject({ granted: false, code: 'denied' })
    tick(15_000)
    await service.daemonHeartbeat('daemon-1')
    expect(await service.current(ORG, CID)).toBeNull()
    expect(await service.release(ORG, CID, { sessionId: 's1', agentId: AGENT_A })).toBe(false)
    expect(await service.acquire(ORG, CID, who('s1'))).toMatchObject({ granted: false, code: 'denied' })
    await service.sessionEnded('s1', AGENT_A, T0 + 1_900_000)
    expect(repo.leases.size).toBe(0)
    expect(await service.acquire(ORG, CID, { ...who('s1'), turnAt: T0 + 1_900_000 })).toMatchObject({
      granted: true,
      fresh: true
    })
  })

  it('keeps a lease renewed by a later turn when an earlier turn end arrives late', async () => {
    const { service, repo } = setup()
    await service.acquire(ORG, CID, who('s1'))
    // The next turn renews the lease 5 s (daemon clock) after the previous turn ended.
    await service.acquire(ORG, CID, { ...who('s1'), turnAt: T0 + 5_000 })
    expect(await service.sessionEnded('s1', AGENT_A, T0)).toBe(0)
    expect(repo.leases.size).toBe(1)
    expect(await service.sessionEnded('s1', AGENT_A, T0 + 5_000)).toBe(1)
  })

  it('lets a pause or takeover reported by the desktop pre-empt the lease', async () => {
    const { service, repo } = setup()
    await service.acquire(ORG, CID, who('s1'))
    expect(await service.observe(ORG, CID, { status: 'human_in_control' })).toBeNull()
    expect(repo.leases.size).toBe(0)
    repo.computers.get(CID)!.status = 'human_in_control'
    expect(await service.acquire(ORG, CID, who('s1'))).toMatchObject({ granted: false, code: 'human_in_control' })
  })

  it('pre-empts on demand and refuses another org', async () => {
    const { service, pushed } = setup()
    expect(await service.acquire('org_2', CID, who('s1'))).toMatchObject({ granted: false, code: 'unavailable' })
    await service.acquire(ORG, CID, who('s1'))
    expect(await service.preempt(ORG, CID, 'revoked')).toBe(true)
    expect(pushed.at(-1)).toBeNull()
    expect(await service.preempt(ORG, CID, 'revoked')).toBe(false)
  })
})

describe('ComputerLeaseService wait queue', () => {
  const waits = { waitMs: 0 }
  // Time passes in 5 s steps: the holder's daemon beats, and the waiting daemons named ask again.
  const pass = async (env: ReturnType<typeof setup>, ms: number, ...asking: Array<ReturnType<typeof who>>) => {
    for (let left = ms; left > 0; left -= 5_000) {
      env.tick(Math.min(5_000, left))
      await env.service.daemonHeartbeat('daemon-1')
      for (const w of asking) await env.service.acquire(ORG, CID, w, waits)
    }
  }

  it('serves waiting sessions first come, first served and reports their place', async () => {
    const env = setup()
    const { service } = env
    await service.acquire(ORG, CID, who('s1'))
    expect(await service.acquire(ORG, CID, who('s2', AGENT_B), waits)).toMatchObject({
      granted: false,
      code: 'computer_busy',
      holder: { sessionId: 's1' },
      queued: { position: 1, waitedMs: 0, leftMs: 45_000 }
    })
    await pass(env, 1_000)
    expect(await service.acquire(ORG, CID, who('s3'), waits)).toMatchObject({ queued: { position: 2 } })
    expect(await service.release(ORG, CID, { sessionId: 's1', agentId: AGENT_A })).toBe(true)
    // The later waiter asks first and still waits behind the earlier one; a caller that does not queue is refused.
    expect(await service.acquire(ORG, CID, who('s3'), waits)).toMatchObject({ queued: { position: 2 } })
    expect(await service.acquire(ORG, CID, who('s4', AGENT_B))).toMatchObject({
      granted: false,
      code: 'computer_busy',
      message: '2 other sessions are waiting for this computer'
    })
    expect(await service.acquire(ORG, CID, who('s2', AGENT_B), waits)).toMatchObject({ granted: true, fresh: true })
    expect(await service.acquire(ORG, CID, who('s3'), waits)).toMatchObject({
      holder: { sessionId: 's2' },
      queued: { position: 1 }
    })
    // The holder's turn ends, so the next in line takes the Computer.
    expect(await service.sessionEnded('s2', AGENT_B, T0)).toBe(1)
    expect(await service.acquire(ORG, CID, who('s3'), waits)).toMatchObject({ granted: true })
    expect(env.repo.queues.get(CID)).toEqual([])
  })

  it('gives up with computer_busy naming the holder once leaseWaitSeconds has passed', async () => {
    const env = setup()
    const { service } = env
    await service.acquire(ORG, CID, who('s1'))
    await service.acquire(ORG, CID, who('s2', AGENT_B), waits)
    await pass(env, 25_000, who('s2', AGENT_B))
    env.tick(5_000)
    expect(await service.acquire(ORG, CID, who('s2', AGENT_B), waits)).toMatchObject({
      queued: { position: 1, waitedMs: 30_000, leftMs: 15_000 }
    })
    await pass(env, 10_000, who('s2', AGENT_B))
    env.tick(5_000)
    const late = await service.acquire(ORG, CID, who('s2', AGENT_B), waits)
    expect(late).toMatchObject({ granted: false, code: 'computer_busy', holder: { sessionId: 's1', agentName: 'Ops' } })
    expect(late.granted === false && late.queued).toBeUndefined()
    expect(env.repo.queues.get(CID)).toEqual([])
  })

  it('never queues when the policy sets no wait', async () => {
    const env = setup()
    env.repo.computers.get(CID)!.policy = ComputerPolicySchema.parse({ leaseWaitSeconds: 0 })
    await env.service.acquire(ORG, CID, who('s1'))
    const busy = await env.service.acquire(ORG, CID, who('s2', AGENT_B), waits)
    expect(busy).toMatchObject({ granted: false, code: 'computer_busy', holder: { sessionId: 's1' } })
    expect(busy.granted === false && busy.queued).toBeUndefined()
  })

  it('drops a waiter whose turn ends, so a late ask of that wait cannot take the Computer', async () => {
    const env = setup()
    const { service } = env
    await service.acquire(ORG, CID, who('s1'))
    await service.acquire(ORG, CID, who('s2', AGENT_B), waits)
    env.tick(1)
    await service.acquire(ORG, CID, who('s3'), waits)
    // A turn end stamped before the wait began leaves it in line.
    await service.sessionEnded('s2', AGENT_B, T0 - 1)
    expect(await service.acquire(ORG, CID, who('s3'), waits)).toMatchObject({ queued: { position: 2 } })
    await service.sessionEnded('s2', AGENT_B, T0)
    expect(await service.acquire(ORG, CID, who('s3'), waits)).toMatchObject({ queued: { position: 1 } })
    await service.release(ORG, CID, { sessionId: 's1', agentId: AGENT_A })
    expect(await service.acquire(ORG, CID, who('s2', AGENT_B), waits)).toMatchObject({
      granted: false,
      code: 'computer_busy',
      message: "this session's turn ended while it waited for this computer"
    })
    expect(await service.acquire(ORG, CID, who('s3'), waits)).toMatchObject({ granted: true })
    // The session's next turn queues again.
    expect(await service.acquire(ORG, CID, { ...who('s2', AGENT_B), turnAt: T0 + 1 }, waits)).toMatchObject({
      queued: { position: 1 }
    })
  })

  it('lets a waiter whose daemon stops asking lapse, and one that loses its grant leave', async () => {
    const env = setup()
    const { service } = env
    await service.acquire(ORG, CID, who('s1'))
    await service.acquire(ORG, CID, who('s2', AGENT_B), waits)
    env.tick(1)
    await service.acquire(ORG, CID, who('s3'), waits)
    await service.release(ORG, CID, { sessionId: 's1', agentId: AGENT_A })
    // s2's daemon was lost: it never asks again, while s3 keeps asking.
    await pass(env, 10_000, who('s3'))
    expect(await service.acquire(ORG, CID, who('s3'), waits)).toMatchObject({ queued: { position: 2 } })
    env.tick(5_000)
    expect(await service.acquire(ORG, CID, who('s3'), waits)).toMatchObject({ granted: true })

    await service.acquire(ORG, CID, who('s5', AGENT_B), waits)
    env.tick(1)
    await service.acquire(ORG, CID, who('s6'), waits)
    env.repo.computers.get(CID)!.agentAccess = { mode: 'selected', agents: [AGENT_A] }
    expect(await service.acquire(ORG, CID, who('s6'), waits)).toMatchObject({ queued: { position: 1 } })
    expect(await service.acquire(ORG, CID, who('s5', AGENT_B), waits)).toMatchObject({ code: 'denied' })
  })

  it('holds the reply while queued and answers as soon as the lease ends on this replica', async () => {
    const { service } = setup()
    await service.acquire(ORG, CID, who('s1'))
    const started = Date.now()
    const held = service.acquire(ORG, CID, who('s2', AGENT_B), { waitMs: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await service.release(ORG, CID, { sessionId: 's1', agentId: AGENT_A })
    expect(await held).toMatchObject({ granted: true })
    expect(Date.now() - started).toBeLessThan(900)
  })

  it('returns the queued answer when the hold runs out', async () => {
    const { repo, ...env } = setup()
    const service = new ComputerLeaseService(repo, env.clock, {
      holderTtlMs: 45_000,
      staleAfterMs: 45_000,
      queuePollMs: 10
    })
    await service.acquire(ORG, CID, who('s1'))
    expect(await service.acquire(ORG, CID, who('s2', AGENT_B), { waitMs: 30 })).toMatchObject({
      queued: { position: 1 }
    })
  })

  it('shows the console who holds the lease and who waits, in order, leaving out lapsed ones', async () => {
    const env = setup()
    const { service, repo } = env
    const view = () => [{ id: CID, ...repo.computers.get(CID)! }]
    expect((await service.occupancy(view())).get(CID)).toEqual({ holder: null, waiting: [] })
    await service.acquire(ORG, CID, who('s1'))
    await service.acquire(ORG, CID, who('s2', AGENT_B), waits)
    await pass(env, 1_000)
    await service.acquire(ORG, CID, who('s3'), waits)
    expect((await service.occupancy(view())).get(CID)).toEqual({
      holder: { sessionId: 's1', agentId: AGENT_A, agentName: 'Ops', acquiredAt: T0 },
      waiting: [
        { sessionId: 's2', agentId: AGENT_B, enqueuedAt: T0 },
        { sessionId: 's3', agentId: AGENT_A, enqueuedAt: T0 + 1_000 }
      ]
    })
    // Nobody asks again and the holder's daemon goes quiet: the view shows neither, without writing anything.
    env.tick(60_000)
    expect((await service.occupancy(view())).get(CID)).toEqual({ holder: null, waiting: [] })
    expect(repo.leases.size).toBe(1)
  })
})
