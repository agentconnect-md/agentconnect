import { describe, expect, it } from 'vitest'
import type { ComputerControlLease } from '@agentconnect.md/protocol'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { ComputerPolicySchema } from '../domain/computer.js'
import type { ControlLease, LeaseComputer, LeaseStep } from '../domain/computerLease.js'
import type { ComputerId, OrgId } from '../domain/ids.js'
import type { ComputerLeaseRepo } from '../persistence/ports.js'
import { ComputerLeaseService } from './computerLeaseService.js'

const T0 = 1_760_000_000_000
const ORG = 'org_1'
const CID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const AGENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const AGENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

class MemoryLeaseRepo implements ComputerLeaseRepo {
  leases = new Map<string, ControlLease>()
  computers = new Map<string, LeaseComputer & { orgId: string }>()

  async get(computerId: ComputerId) {
    return this.leases.get(computerId) ?? null
  }
  async step<R>(
    orgId: OrgId,
    computerId: ComputerId,
    decide: (c: LeaseComputer | null, l: ControlLease | null) => LeaseStep<R>
  ) {
    const computer = this.computers.get(computerId)
    const visible = computer && computer.orgId === orgId ? computer : null
    const { next, result } = decide(visible, visible ? (this.leases.get(computerId) ?? null) : null)
    if (next === null) this.leases.delete(computerId)
    if (next) this.leases.set(computerId, next)
    return result
  }
  async listBySession(sessionId: string) {
    return [...this.leases.values()].filter((l) => l.sessionId === sessionId)
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
    policy: ComputerPolicySchema.parse({ allowedAgents: [AGENT_A, AGENT_B] })
  })
  const pushed: Array<ComputerControlLease | null> = []
  const service = new ComputerLeaseService(repo, clock, {
    holderTtlMs: 45_000,
    staleAfterMs: 45_000,
    channels: { pushLease: (_id, lease) => pushed.push(lease) }
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
  daemonId: 'daemon-1'
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
      await service.observe(ORG, CID, { status: 'busy', lease: { holder: 's1', idleMs: 0 } })
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
      await service.observe(ORG, CID, { status: 'busy', lease: { holder: 's1', idleMs: 0 } })
      await service.daemonHeartbeat('daemon-1')
    }
    expect(await service.current(ORG, CID)).toBeNull()
    expect(await service.acquire(ORG, CID, who('s2', AGENT_B))).toMatchObject({ granted: true, fresh: true })
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
