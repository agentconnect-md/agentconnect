/** Real-Postgres coverage for Kubernetes identity-to-daemon bindings. */
import { describe, it, expect } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { PgDaemonRepo } from '../../src/persistence/repositories/daemon.repo.js'
import { DaemonId, OrgId } from '../../src/domain/ids.js'

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
