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

const IDENTITY = 'system:serviceaccount:ac-org-example:ac-daemon'
const INSTALL_IDENTITY = 'system:serviceaccount:agentconnect:ac-cloud-daemon'
const POD_UID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const POD_UID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const DEF_ORG = OrgId(DEFAULT_ORG_ID)

describe('DaemonRepo.resolveClusterIdentity', () => {
  it('provisions a record on first sight and returns the same one afterwards', async () => {
    const repo = new PgDaemonRepo(prisma)

    const first = await repo.resolveClusterIdentity(DEF_ORG, IDENTITY)
    const second = await repo.resolveClusterIdentity(DEF_ORG, IDENTITY)

    expect(first).not.toBeNull()
    expect(second?.id).toBe(first!.id)
    expect(first!.orgId).toBe(DEFAULT_ORG_ID)
    // Provisioned, not authenticating: `upsertOnAuth` still mints the epoch afterwards.
    expect(await prisma.daemon.count({ where: { clusterIdentity: IDENTITY } })).toBe(1)
  })

  it('keeps the record — and its history — when the envelope is rebuilt', async () => {
    const repo = new PgDaemonRepo(prisma)
    const provisioned = await repo.resolveClusterIdentity(DEF_ORG, IDENTITY)
    await repo.upsertOnAuth({ daemonId: DaemonId(provisioned!.id), orgId: DEF_ORG, agentVersion: '1.0.0' })
    await prisma.daemon.update({ where: { id: provisioned!.id }, data: { name: 'named by a human' } })

    // A torn-down and re-provisioned envelope derives the same namespace, so the same
    // identity arrives again — and must not strand the placements under a fresh record.
    const afterRebuild = await repo.resolveClusterIdentity(DEF_ORG, IDENTITY)

    expect(afterRebuild?.id).toBe(provisioned!.id)
    expect(afterRebuild?.name).toBe('named by a human')
    expect(afterRebuild?.sessionEpoch).toBe(1n)
  })

  it('binds one record per identity, so two orgs cannot share one envelope', async () => {
    const repo = new PgDaemonRepo(prisma)
    const other = await prisma.org.create({ data: { slug: 'other-cluster-org' } })

    const mine = await repo.resolveClusterIdentity(DEF_ORG, IDENTITY)
    const theirs = await repo.resolveClusterIdentity(OrgId(other.id), IDENTITY)

    expect(mine).not.toBeNull()
    // Refused rather than re-bound: an identity may not move tenants.
    expect(theirs).toBeNull()
    expect(await prisma.daemon.count({ where: { clusterIdentity: IDENTITY } })).toBe(1)
  })

  it('adopts the record the key path already pinned, instead of stranding it', async () => {
    const repo = new PgDaemonRepo(prisma)
    // An envelope provisioned before the token path: its daemon record exists and carries
    // the placements and history the key-backed connection built up.
    const keyBacked = DaemonId('55555555-5555-4555-8555-555555555555')
    await repo.provision(keyBacked, DEF_ORG)
    await repo.upsertOnAuth({ daemonId: keyBacked, orgId: DEF_ORG, agentVersion: '1.0.0' })

    const bound = await repo.resolveClusterIdentity(DEF_ORG, IDENTITY, { adoptDaemonId: keyBacked })

    expect(bound?.id).toBe(keyBacked)
    expect(bound?.sessionEpoch).toBe(1n)
    expect(await prisma.daemon.count({ where: { orgId: DEFAULT_ORG_ID } })).toBe(1)
  })

  it('ignores an adoption candidate that already carries another identity', async () => {
    const repo = new PgDaemonRepo(prisma)
    const taken = await repo.resolveClusterIdentity(DEF_ORG, 'system:serviceaccount:ac-org-other:ac-daemon')

    const bound = await repo.resolveClusterIdentity(DEF_ORG, IDENTITY, { adoptDaemonId: taken!.id })

    expect(bound).not.toBeNull()
    expect(bound!.id).not.toBe(taken!.id)
    expect(await prisma.daemon.findUnique({ where: { id: taken!.id } })).toMatchObject({
      clusterIdentity: 'system:serviceaccount:ac-org-other:ac-daemon'
    })
  })

  it('ignores an adoption candidate belonging to another org', async () => {
    const repo = new PgDaemonRepo(prisma)
    const other = await prisma.org.create({ data: { slug: 'adoption-other-org' } })
    const theirs = DaemonId('66666666-6666-4666-8666-666666666666')
    await repo.provision(theirs, OrgId(other.id))

    const bound = await repo.resolveClusterIdentity(DEF_ORG, IDENTITY, { adoptDaemonId: theirs })

    expect(bound!.id).not.toBe(theirs)
    expect(await prisma.daemon.findUnique({ where: { id: theirs } })).toMatchObject({ clusterIdentity: null })
  })

  it('gives distinct identities distinct records within one org', async () => {
    const repo = new PgDaemonRepo(prisma)

    const a = await repo.resolveClusterIdentity(DEF_ORG, IDENTITY)
    const b = await repo.resolveClusterIdentity(DEF_ORG, 'system:serviceaccount:ac-org-second:ac-daemon')

    expect(a!.id).not.toBe(b!.id)
  })

  it('leaves a key-authenticated daemon in the same org unbound', async () => {
    const repo = new PgDaemonRepo(prisma)
    const laptop = DaemonId('44444444-4444-4444-8444-444444444444')
    await repo.provision(laptop, DEF_ORG)

    const envelope = await repo.resolveClusterIdentity(DEF_ORG, IDENTITY)

    expect(envelope!.id).not.toBe(laptop)
    expect(await prisma.daemon.findUnique({ where: { id: laptop } })).toMatchObject({ clusterIdentity: null })
  })

  it('keeps cloud Pods out of owned reads while exposing them to availability reads', async () => {
    const repo = new PgDaemonRepo(prisma)
    const other = await prisma.org.create({ data: { slug: 'install-daemon-other-org' } })

    const first = await repo.resolveCloudClusterIdentity(INSTALL_IDENTITY, POD_UID_A)
    const samePod = await repo.resolveCloudClusterIdentity(INSTALL_IDENTITY, POD_UID_A)
    const secondPod = await repo.resolveCloudClusterIdentity(INSTALL_IDENTITY, POD_UID_B)

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

describe('DaemonRepo cloud-member retirement', () => {
  const HOUR_AGO = new Date(Date.now() - 60 * 60_000)
  const CUTOFF = new Date(Date.now() - 15 * 60_000)

  it('finds only the org-less cloud rows silent past the cutoff', async () => {
    const repo = new PgDaemonRepo(prisma)
    const gone = await repo.resolveCloudClusterIdentity(INSTALL_IDENTITY, POD_UID_A)
    const serving = await repo.resolveCloudClusterIdentity(INSTALL_IDENTITY, POD_UID_B)
    await prisma.daemon.update({ where: { id: gone.id }, data: { lastSeenAt: HOUR_AGO } })
    await prisma.daemon.update({ where: { id: serving.id }, data: { lastSeenAt: new Date() } })
    // Neither of these is a cloud member: an envelope daemon is bound to a namespace rather
    // than a Pod, and a laptop has no identity at all. Both are long silent regardless.
    const envelope = await repo.resolveClusterIdentity(DEF_ORG, IDENTITY)
    const laptop = DaemonId('77777777-7777-4777-8777-777777777777')
    await repo.provision(laptop, DEF_ORG)
    for (const id of [envelope!.id, laptop]) {
      await prisma.daemon.update({ where: { id }, data: { lastSeenAt: HOUR_AGO } })
    }

    const retired = await repo.findRetiredCloudMembers(CUTOFF)

    expect(retired.map((daemon) => daemon.id)).toEqual([gone.id])
  })

  it('judges a member that never heartbeated by its own age', async () => {
    const repo = new PgDaemonRepo(prisma)
    const fresh = await repo.resolveCloudClusterIdentity(INSTALL_IDENTITY, POD_UID_A)

    // Authenticated and died before its first beat: `lastSeenAt` stays null forever, so a
    // brand-new row must survive the sweep and an old one must not.
    expect(await repo.findRetiredCloudMembers(CUTOFF)).toEqual([])
    await prisma.daemon.update({ where: { id: fresh.id }, data: { createdAt: HOUR_AGO } })

    expect((await repo.findRetiredCloudMembers(CUTOFF)).map((daemon) => daemon.id)).toEqual([fresh.id])
  })

  it('retires a member and settles its agents in one transaction, refusing anything else', async () => {
    const repo = new PgDaemonRepo(prisma)
    const pod = await repo.resolveCloudClusterIdentity(INSTALL_IDENTITY, POD_UID_A)
    await prisma.daemon.update({ where: { id: pod.id }, data: { lastSeenAt: HOUR_AGO } })
    // An agent from an ordinary org, hosted on install-wide infrastructure — the shape only a
    // cloud member has, and the reason the settlement cannot be org-scoped.
    const hosted = AgentId('a9999999-9999-4999-8999-999999999999')
    await seedAgent(prisma, hosted, { daemonId: pod.id })
    await new PgAgentRepo(prisma).setPlacement(hosted, onDaemon(pod.id))
    const envelope = await repo.resolveClusterIdentity(DEF_ORG, IDENTITY)
    const laptop = DaemonId('88888888-8888-4888-8888-888888888888')
    await repo.provision(laptop, DEF_ORG)
    for (const id of [envelope!.id, laptop]) {
      await prisma.daemon.update({ where: { id }, data: { lastSeenAt: HOUR_AGO } })
    }
    const fence = { retiredBefore: CUTOFF, sessionEpoch: pod.sessionEpoch }

    expect(await repo.retireCloudMember(pod.id, fence)).toEqual({
      deleted: true,
      settled: [{ id: hosted, orgId: DEFAULT_ORG_ID }]
    })
    // The agent left the same commit as the row: unplaced AND no longer claiming to run.
    expect(await prisma.agent.findUnique({ where: { id: hosted } })).toMatchObject({
      daemonId: null,
      status: 'inactive'
    })
    // Gone, so a repeat (a peer replica sweeping the same row) is a no-op, not an error.
    expect(await repo.retireCloudMember(pod.id, fence)).toMatchObject({ deleted: false })
    expect(await repo.retireCloudMember(envelope!.id, fence)).toMatchObject({ deleted: false })
    expect(await repo.retireCloudMember(laptop, fence)).toMatchObject({ deleted: false })
    expect(await prisma.daemon.findUnique({ where: { id: pod.id } })).toBeNull()
    expect(await prisma.daemon.findUnique({ where: { id: envelope!.id } })).not.toBeNull()
    expect(await prisma.daemon.findUnique({ where: { id: laptop } })).not.toBeNull()
  })

  it('does not unplace a POOL agent when the member serving it is retired', async () => {
    // A pool agent is not placed ON the member — the member only holds its duty — so retiring the
    // Pod must leave the placement alone. Unplacing it would set `status: 'inactive'` and strand
    // it exactly the way the reaper stranded agents before placement became a target: nothing
    // re-places an unplaced agent, so it would be permanently offline.
    const repo = new PgDaemonRepo(prisma)
    const pod = await repo.resolveCloudClusterIdentity(INSTALL_IDENTITY, POD_UID_A)
    await prisma.daemon.update({ where: { id: pod.id }, data: { lastSeenAt: HOUR_AGO } })
    const pooled = AgentId('a8888888-8888-4888-8888-888888888888')
    await seedAgent(prisma, pooled)
    await prisma.agent.update({
      where: { id: pooled },
      data: { placementKind: 'set', setId: await poolSetId(prisma), daemonId: null, status: 'active' }
    })

    expect(await repo.retireCloudMember(pod.id, { retiredBefore: CUTOFF, sessionEpoch: pod.sessionEpoch })).toEqual({
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
    const pod = await repo.resolveCloudClusterIdentity(INSTALL_IDENTITY, POD_UID_A)
    await prisma.daemon.update({ where: { id: pod.id }, data: { lastSeenAt: HOUR_AGO } })
    const observed = (await repo.findRetiredCloudMembers(CUTOFF))[0]!

    // Re-auth is the case `lastSeenAt` alone cannot catch: it bumps the epoch atomically,
    // while the clock only moves on the first heartbeat AFTER it.
    await repo.upsertOnAuth({ daemonId: pod.id, orgId: null, agentVersion: '1.0.0' })

    expect(
      await repo.retireCloudMember(pod.id, { retiredBefore: CUTOFF, sessionEpoch: observed.sessionEpoch })
    ).toMatchObject({ deleted: false })
    expect(await prisma.daemon.findUnique({ where: { id: pod.id } })).not.toBeNull()

    // A heartbeat is caught by the cutoff half of the same fence.
    await prisma.daemon.update({ where: { id: pod.id }, data: { lastSeenAt: new Date() } })
    const current = await repo.getUnscoped(pod.id)
    expect(
      await repo.retireCloudMember(pod.id, { retiredBefore: CUTOFF, sessionEpoch: current!.sessionEpoch })
    ).toMatchObject({ deleted: false })
    expect(await prisma.daemon.findUnique({ where: { id: pod.id } })).not.toBeNull()
  })
})
