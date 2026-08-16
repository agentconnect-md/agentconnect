/** Real-Postgres coverage for Kubernetes identity-to-daemon bindings. */
import { onDaemon } from '../../src/domain/placement.js'
import { describe, it, expect } from 'vitest'
import { prisma } from '../setup.db.js'
import { poolSetId } from '../fakes/member-set.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { seedAgent } from '../fixtures/seed.js'
import { PgDaemonRepo } from '../../src/persistence/repositories/daemon.repo.js'
import { PgAgentRepo } from '../../src/persistence/repositories/agent.repo.js'
import { AgentId, DaemonId, OrgId } from '../../src/domain/ids.js'

const INSTALL_IDENTITY = 'system:serviceaccount:agentconnect:ac-cloud-daemon'
const POD_UID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const POD_UID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const DEF_ORG = OrgId(DEFAULT_ORG_ID)

describe('DaemonRepo.resolvePoolClusterIdentity', () => {
  it('keeps pool member Pods out of owned reads while exposing them to availability reads', async () => {
    const repo = new PgDaemonRepo(prisma)
    const other = await prisma.org.create({ data: { slug: 'install-daemon-other-org' } })

    const first = await repo.resolvePoolClusterIdentity(INSTALL_IDENTITY, POD_UID_A)
    const samePod = await repo.resolvePoolClusterIdentity(INSTALL_IDENTITY, POD_UID_A)
    const secondPod = await repo.resolvePoolClusterIdentity(INSTALL_IDENTITY, POD_UID_B)

    expect(samePod.id).toBe(first.id)
    expect(secondPod.id).not.toBe(first.id)
    expect(first.orgId).toBeNull()
    expect(secondPod.orgId).toBeNull()
    expect(await repo.get(DEF_ORG, first.id)).toBeNull()
    expect(await repo.get(OrgId(other.id), secondPod.id)).toBeNull()
    const ownedByDefault = (await repo.list(DEF_ORG)).map((daemon) => daemon.id)
    const ownedByOther = (await repo.list(OrgId(other.id))).map((daemon) => daemon.id)
    expect(ownedByDefault).not.toContain(first.id)
    expect(ownedByDefault).not.toContain(secondPod.id)
    expect(ownedByOther).not.toContain(first.id)
    expect(ownedByOther).not.toContain(secondPod.id)
    expect(await repo.getAvailable(DEF_ORG, first.id)).toMatchObject({ id: first.id, orgId: null })
    expect(await repo.getAvailable(OrgId(other.id), secondPod.id)).toMatchObject({ id: secondPod.id, orgId: null })
    expect((await repo.listAvailable(DEF_ORG)).map((daemon) => daemon.id)).toEqual(
      expect.arrayContaining([first.id, secondPod.id])
    )
    expect((await repo.listAvailable(OrgId(other.id))).map((daemon) => daemon.id)).toEqual(
      expect.arrayContaining([first.id, secondPod.id])
    )
    await expect(repo.rename(DEF_ORG, first.id, 'tenant must not rename shared infrastructure')).rejects.toThrow()
    expect(await prisma.daemon.count({ where: { clusterIdentity: INSTALL_IDENTITY } })).toBe(2)
  })
})

describe('DaemonRepo pool-member retirement', () => {
  const HOUR_AGO = new Date(Date.now() - 60 * 60_000)
  const CUTOFF = new Date(Date.now() - 15 * 60_000)

  it('finds only the org-less pool member rows silent past the cutoff', async () => {
    const repo = new PgDaemonRepo(prisma)
    const gone = await repo.resolvePoolClusterIdentity(INSTALL_IDENTITY, POD_UID_A)
    const serving = await repo.resolvePoolClusterIdentity(INSTALL_IDENTITY, POD_UID_B)
    await prisma.daemon.update({ where: { id: gone.id }, data: { lastSeenAt: HOUR_AGO } })
    await prisma.daemon.update({ where: { id: serving.id }, data: { lastSeenAt: new Date() } })
    // Not a pool member: a laptop has no cluster identity at all, and is long silent regardless.
    const laptop = DaemonId('77777777-7777-4777-8777-777777777777')
    await repo.provision(laptop, DEF_ORG)
    await prisma.daemon.update({ where: { id: laptop }, data: { lastSeenAt: HOUR_AGO } })

    const retired = await repo.findRetiredPoolMembers(CUTOFF)

    expect(retired.map((daemon) => daemon.id)).toEqual([gone.id])
  })

  it('judges a member that never heartbeated by its own age', async () => {
    const repo = new PgDaemonRepo(prisma)
    const fresh = await repo.resolvePoolClusterIdentity(INSTALL_IDENTITY, POD_UID_A)

    // Authenticated and died before its first beat: `lastSeenAt` stays null forever, so a
    // brand-new row must survive the sweep and an old one must not.
    expect(await repo.findRetiredPoolMembers(CUTOFF)).toEqual([])
    await prisma.daemon.update({ where: { id: fresh.id }, data: { createdAt: HOUR_AGO } })

    expect((await repo.findRetiredPoolMembers(CUTOFF)).map((daemon) => daemon.id)).toEqual([fresh.id])
  })

  it('retires a member and settles its agents in one transaction, refusing anything else', async () => {
    const repo = new PgDaemonRepo(prisma)
    const pod = await repo.resolvePoolClusterIdentity(INSTALL_IDENTITY, POD_UID_A)
    await prisma.daemon.update({ where: { id: pod.id }, data: { lastSeenAt: HOUR_AGO } })
    // An agent from an ordinary org, hosted on install-wide infrastructure — the shape only a
    // pool member has, and the reason the settlement cannot be org-scoped.
    const hosted = AgentId('a9999999-9999-4999-8999-999999999999')
    await seedAgent(prisma, hosted, { daemonId: pod.id })
    await new PgAgentRepo(prisma).setPlacement(hosted, onDaemon(pod.id))
    const laptop = DaemonId('88888888-8888-4888-8888-888888888888')
    await repo.provision(laptop, DEF_ORG)
    await prisma.daemon.update({ where: { id: laptop }, data: { lastSeenAt: HOUR_AGO } })
    const fence = { retiredBefore: CUTOFF, sessionEpoch: pod.sessionEpoch }

    expect(await repo.retirePoolMember(pod.id, fence)).toEqual({
      deleted: true,
      settled: [{ id: hosted, orgId: DEFAULT_ORG_ID }]
    })
    // The agent left the same commit as the row: unplaced AND no longer claiming to run.
    expect(await prisma.agent.findUnique({ where: { id: hosted } })).toMatchObject({
      daemonId: null,
      status: 'inactive'
    })
    // Gone, so a repeat (a peer replica sweeping the same row) is a no-op, not an error.
    expect(await repo.retirePoolMember(pod.id, fence)).toMatchObject({ deleted: false })
    expect(await repo.retirePoolMember(laptop, fence)).toMatchObject({ deleted: false })
    expect(await prisma.daemon.findUnique({ where: { id: pod.id } })).toBeNull()
    expect(await prisma.daemon.findUnique({ where: { id: laptop } })).not.toBeNull()
  })

  it('does not unplace a POOL agent when the member serving it is retired', async () => {
    // A pool agent is not placed ON the member — the member only holds its duty — so retiring the
    // Pod must leave the placement alone. Unplacing it would set `status: 'inactive'` and strand
    // it exactly the way the reaper stranded agents before placement became a target: nothing
    // re-places an unplaced agent, so it would be permanently offline.
    const repo = new PgDaemonRepo(prisma)
    const pod = await repo.resolvePoolClusterIdentity(INSTALL_IDENTITY, POD_UID_A)
    await prisma.daemon.update({ where: { id: pod.id }, data: { lastSeenAt: HOUR_AGO } })
    const pooled = AgentId('a8888888-8888-4888-8888-888888888888')
    await seedAgent(prisma, pooled)
    await prisma.agent.update({
      where: { id: pooled },
      data: { placementKind: 'set', setId: await poolSetId(prisma), daemonId: null, status: 'active' }
    })

    expect(await repo.retirePoolMember(pod.id, { retiredBefore: CUTOFF, sessionEpoch: pod.sessionEpoch })).toEqual({
      deleted: true,
      settled: []
    })
    expect(await prisma.agent.findUnique({ where: { id: pooled } })).toMatchObject({
      placementKind: 'set',
      daemonId: null,
      status: 'active'
    })
  })

  it('refuses a member that came back between the worklist read and the delete', async () => {
    const repo = new PgDaemonRepo(prisma)
    const pod = await repo.resolvePoolClusterIdentity(INSTALL_IDENTITY, POD_UID_A)
    await prisma.daemon.update({ where: { id: pod.id }, data: { lastSeenAt: HOUR_AGO } })
    const observed = (await repo.findRetiredPoolMembers(CUTOFF))[0]!

    // Re-auth is the case `lastSeenAt` alone cannot catch: it bumps the epoch atomically,
    // while the clock only moves on the first heartbeat AFTER it.
    await repo.upsertOnAuth({ daemonId: pod.id, orgId: null, agentVersion: '1.0.0' })

    expect(
      await repo.retirePoolMember(pod.id, { retiredBefore: CUTOFF, sessionEpoch: observed.sessionEpoch })
    ).toMatchObject({ deleted: false })
    expect(await prisma.daemon.findUnique({ where: { id: pod.id } })).not.toBeNull()

    // A heartbeat is caught by the cutoff half of the same fence.
    await prisma.daemon.update({ where: { id: pod.id }, data: { lastSeenAt: new Date() } })
    const current = await repo.getUnscoped(pod.id)
    expect(
      await repo.retirePoolMember(pod.id, { retiredBefore: CUTOFF, sessionEpoch: current!.sessionEpoch })
    ).toMatchObject({ deleted: false })
    expect(await prisma.daemon.findUnique({ where: { id: pod.id } })).not.toBeNull()
  })
})
