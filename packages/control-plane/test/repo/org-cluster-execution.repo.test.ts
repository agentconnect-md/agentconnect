/**
 * The selection behind the provisioner's periodic re-apply. It needs real
 * Postgres because all three properties ARE the query: only enabled envelopes,
 * never one whose transition someone currently owns, and a keyset page that
 * rotates through a fleet larger than one pass.
 */
import { describe, it, expect } from 'vitest'
import { prisma } from '../setup.db.js'
import { PgOrgClusterExecutionRepo } from '../../src/persistence/repositories/org-cluster-execution.repo.js'
import { OrgId } from '../../src/domain/ids.js'
import type { ClusterExecutionDefaults } from '../../src/persistence/ports.js'

const NOW = new Date('2026-01-01T00:00:00.000Z')
const LEASE_MS = 2 * 60 * 1000

function defaults(name: string): ClusterExecutionDefaults {
  return {
    resourceName: name,
    daemonImage: 'registry.example.test/daemon:1',
    daemonTier: 'small',
    runtimeImage: 'registry.example.test/runtime:1',
    runtimeTiers: [{ name: 'small', warmReplicas: 0 }],
    quota: { maxAgents: 0, cpu: '0', memory: '0', storage: '0' },
    egressPolicy: 'curated'
  }
}

/** An org with an envelope row, id fixed so the keyset order is the test's to state. */
async function seedEnvelope(repo: PgOrgClusterExecutionRepo, id: string, enabled: boolean): Promise<OrgId> {
  await prisma.org.create({ data: { id, slug: id } })
  const orgId = OrgId(id)
  await repo.createIfAbsent(orgId, defaults(id))
  if (enabled) await repo.upsert(orgId, defaults(id), { enabled: true })
  return orgId
}

describe('OrgClusterExecutionRepo.listResyncableOrgIds', () => {
  it('names the enabled envelopes and nothing else', async () => {
    const repo = new PgOrgClusterExecutionRepo(prisma)
    await seedEnvelope(repo, 'env-a', true)
    // A row that reads disabled is an owner's decision; re-applying would undo it.
    await seedEnvelope(repo, 'env-b', false)

    expect(await repo.listResyncableOrgIds(null, 10, NOW, LEASE_MS)).toEqual(['env-a'])
  })

  it('leaves an envelope whose transition someone owns, until the lease expires', async () => {
    const repo = new PgOrgClusterExecutionRepo(prisma)
    const orgId = await seedEnvelope(repo, 'env-a', true)
    await repo.beginTransition(orgId, 'peer-token', NOW, LEASE_MS)

    expect(await repo.listResyncableOrgIds(null, 10, NOW, LEASE_MS)).toEqual([])

    // A claim older than the lease is taken over everywhere else, so a crashed
    // holder must not exclude its org from convergence forever either.
    const afterLease = new Date(NOW.getTime() + LEASE_MS + 1)
    expect(await repo.listResyncableOrgIds(null, 10, afterLease, LEASE_MS)).toEqual(['env-a'])

    await repo.endTransition(orgId, 'peer-token')
    expect(await repo.listResyncableOrgIds(null, 10, NOW, LEASE_MS)).toEqual(['env-a'])
  })

  it('pages forward by org id, so consecutive passes cover the whole fleet', async () => {
    const repo = new PgOrgClusterExecutionRepo(prisma)
    for (const id of ['env-a', 'env-b', 'env-c']) await seedEnvelope(repo, id, true)

    const first = await repo.listResyncableOrgIds(null, 2, NOW, LEASE_MS)
    expect(first).toEqual(['env-a', 'env-b'])
    expect(await repo.listResyncableOrgIds(first.at(-1)!, 2, NOW, LEASE_MS)).toEqual(['env-c'])
  })

  it('is empty for a deployment with no envelopes at all', async () => {
    const repo = new PgOrgClusterExecutionRepo(prisma)
    expect(await repo.listResyncableOrgIds(null, 10, NOW, LEASE_MS)).toEqual([])
  })
})
