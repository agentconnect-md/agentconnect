/**
 * The daemon record an in-cluster daemon's verified Kubernetes identity resolves to
 * (docs/designs/agentconnect-org-operator.md, "Which daemon record"). Three properties,
 * all of which need real Postgres because the unique index is what enforces the first.
 */
import { describe, it, expect } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { PgDaemonRepo } from '../../src/persistence/repositories/daemon.repo.js'
import { DaemonId, OrgId } from '../../src/domain/ids.js'

const IDENTITY = 'system:serviceaccount:ac-org-example:ac-daemon'
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
})
