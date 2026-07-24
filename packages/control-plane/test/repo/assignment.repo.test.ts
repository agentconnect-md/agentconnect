/**
 * AssignmentRepo.assign — the routing-table invariant (design §3.7, §6 Phase 1).
 *
 * THE load-bearing Postgres behavior: the partial unique index
 * `assignment_session_active_uq` on (platform, channel, threadKey) WHERE state
 * IN ('active','draining','frozen') guarantees AT MOST ONE active daemon serves
 * a session (protocol §5.3). A `released` row is excluded, so reassigning after
 * drain/done under a new epoch does NOT collide.
 *
 * Channel-root (`thread` absent) collapses to threadKey '' via the generated
 * column, so a channel-root and a thread assignment for the same channel are
 * distinct — and two channel-roots correctly conflict.
 */
import { describe, it, expect } from 'vitest'
import { prisma } from '../setup.db.js'
import { PgAssignmentRepo } from '../../src/persistence/repositories/assignment.repo.js'
import { OwnerConflict } from '../../src/persistence/errors.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import type { SessionKey } from '../../src/domain/sessionKey.js'
import { AgentId, DaemonId, WorkspaceId } from '../../src/domain/ids.js'

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DAEMON_A = 'd1111111-1111-4111-8111-111111111111'
const DAEMON_B = 'd2222222-2222-4222-8222-222222222222'

const ROOT: SessionKey = { platform: 'slack', channel: 'C1' } // channel-root → threadKey ''
const THREAD: SessionKey = { platform: 'slack', channel: 'C1', thread: 'T1' }

async function fixtures(): Promise<WorkspaceId> {
  await seedDaemon(prisma, DAEMON_A)
  await seedDaemon(prisma, DAEMON_B)
  await seedAgent(prisma, AGENT)
  // workspace is inline now; the assignment's opaque scope id = the agent id.
  return WorkspaceId(AGENT)
}

describe('AssignmentRepo.assign — partial-unique single-owner invariant (real Postgres)', () => {
  it('allows the first active assignment for a sessionKey', async () => {
    const ws = await fixtures()
    const repo = new PgAssignmentRepo(prisma)

    const a = await repo.assign(ROOT, AgentId(AGENT), DaemonId(DAEMON_A), ws, 1n, 1n)
    expect(a.state).toBe('active')
    expect(a.daemonId).toBe(DAEMON_A)
    expect(a.thread).toBeNull() // channel-root
  })

  it('REJECTS a second active owner for the same sessionKey with OwnerConflict', async () => {
    const ws = await fixtures()
    const repo = new PgAssignmentRepo(prisma)

    await repo.assign(ROOT, AgentId(AGENT), DaemonId(DAEMON_A), ws, 1n, 1n)

    await expect(repo.assign(ROOT, AgentId(AGENT), DaemonId(DAEMON_B), ws, 2n, 2n)).rejects.toBeInstanceOf(
      OwnerConflict
    )
  })

  it('does NOT collide once the first owner is released (reassign under new epoch)', async () => {
    const ws = await fixtures()
    const repo = new PgAssignmentRepo(prisma)

    await repo.assign(ROOT, AgentId(AGENT), DaemonId(DAEMON_A), ws, 1n, 1n)
    await repo.release(ROOT, new Date())

    // a released row is excluded from the partial-unique index → this succeeds
    const reassigned = await repo.assign(ROOT, AgentId(AGENT), DaemonId(DAEMON_B), ws, 2n, 2n)
    expect(reassigned.state).toBe('active')
    expect(reassigned.daemonId).toBe(DAEMON_B)
    expect(reassigned.assignedEpoch).toBe(2n)
  })

  it('treats channel-root and a thread on the same channel as DISTINCT sessions', async () => {
    const ws = await fixtures()
    const repo = new PgAssignmentRepo(prisma)

    const root = await repo.assign(ROOT, AgentId(AGENT), DaemonId(DAEMON_A), ws, 1n, 1n)
    const thread = await repo.assign(THREAD, AgentId(AGENT), DaemonId(DAEMON_A), ws, 1n, 1n)

    expect(root.thread).toBeNull()
    expect(thread.thread).toBe('T1')
    // both are active and coexist — no conflict
    const active = await repo.activeForDaemon(DaemonId(DAEMON_A))
    expect(active).toHaveLength(2)
  })

  it("activeForDaemon returns only this daemon's non-released assignments", async () => {
    const ws = await fixtures()
    const repo = new PgAssignmentRepo(prisma)

    await repo.assign(ROOT, AgentId(AGENT), DaemonId(DAEMON_A), ws, 1n, 1n)
    await repo.assign(THREAD, AgentId(AGENT), DaemonId(DAEMON_B), ws, 1n, 1n)

    const a = await repo.activeForDaemon(DaemonId(DAEMON_A))
    expect(a).toHaveLength(1)
    expect(a[0]?.daemonId).toBe(DAEMON_A)
  })

  it('ownerOf returns the active owner and null after release', async () => {
    const ws = await fixtures()
    const repo = new PgAssignmentRepo(prisma)

    await repo.assign(THREAD, AgentId(AGENT), DaemonId(DAEMON_A), ws, 1n, 1n)
    expect((await repo.ownerOf(THREAD))?.daemonId).toBe(DAEMON_A)

    await repo.release(THREAD, new Date())
    expect(await repo.ownerOf(THREAD)).toBeNull()
  })

  it('releaseForAgent drops only the moved agent affinities on the source daemon', async () => {
    const ws = await fixtures()
    const otherAgent = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    await seedAgent(prisma, otherAgent)
    const repo = new PgAssignmentRepo(prisma)
    const releasedAt = new Date('2026-07-11T00:00:00.000Z')

    await repo.assign(ROOT, AgentId(AGENT), DaemonId(DAEMON_A), ws, 1n, 1n)
    await repo.assign(
      { platform: 'slack', channel: 'C2' },
      AgentId(otherAgent),
      DaemonId(DAEMON_A),
      WorkspaceId(otherAgent),
      1n,
      1n
    )
    const keys = await repo.releaseForAgent(AgentId(AGENT), DaemonId(DAEMON_A), releasedAt)

    expect(keys).toEqual([ROOT])
    expect(await repo.ownerOf(ROOT)).toBeNull()
    expect((await repo.ownerOf({ platform: 'slack', channel: 'C2' }))?.agentId).toBe(otherAgent)
    const released = await prisma.assignment.findFirstOrThrow({ where: { agentId: AGENT } })
    expect(released).toMatchObject({ state: 'released', daemonId: null, releasedAt })
  })

  it("freeze flips a daemon's active assignments to frozen (still single-owner)", async () => {
    const ws = await fixtures()
    const repo = new PgAssignmentRepo(prisma)

    await repo.assign(THREAD, AgentId(AGENT), DaemonId(DAEMON_A), ws, 1n, 1n)
    await repo.freeze(DaemonId(DAEMON_A))

    // frozen is still inside the partial-unique predicate, so a new owner is rejected
    await expect(repo.assign(THREAD, AgentId(AGENT), DaemonId(DAEMON_B), ws, 2n, 2n)).rejects.toBeInstanceOf(
      OwnerConflict
    )
  })
})
