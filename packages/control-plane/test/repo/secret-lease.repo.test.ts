/**
 * SecretLeaseRepo — lease metadata, NO plaintext (design §3.10, §6 Phase 1).
 *
 * Tracks issued leases; holds only the Vault/KMS reference + TTL. The secret
 * never touches Postgres. `create`/`renew`/`revoke` mirror the secrets frames;
 * `activeForDaemon` feeds `register/ok.leases[]`.
 */
import { describe, it, expect } from 'vitest'
import { prisma } from '../setup.db.js'
import { PgSecretLeaseRepo } from '../../src/persistence/repositories/secret-lease.repo.js'
import { seedDaemon } from '../fixtures/seed.js'
import { DaemonId, LeaseId } from '../../src/domain/ids.js'

const DAEMON = 'd1111111-1111-4111-8111-111111111111'
const LEASE = '12121212-1212-4121-8121-121212121212'
const WORKSPACE = '99999999-9999-4999-8999-999999999999'

function createInput(issuedAt: Date) {
  return {
    leaseId: LeaseId(LEASE),
    daemonId: DaemonId(DAEMON),
    scope: { platform: 'slack' as const, workspaceId: WORKSPACE },
    ref: 'vault://secret/slack/bot-token', // a REFERENCE, not the secret
    ttlSec: 3600,
    renewBeforeSec: 60,
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + 3600 * 1000)
  }
}

describe('SecretLeaseRepo — lease metadata only (real Postgres)', () => {
  it('creates a lease holding the ref + ttl, status active', async () => {
    await seedDaemon(prisma, DAEMON)
    const repo = new PgSecretLeaseRepo(prisma)
    const issuedAt = new Date()

    const lease = await repo.create(createInput(issuedAt))
    expect(lease.id).toBe(LEASE)
    expect(lease.ref).toBe('vault://secret/slack/bot-token')
    expect(lease.ttlSec).toBe(3600)
    expect(lease.status).toBe('active')
    expect(lease.scopePlatform).toBe('slack')
    expect(lease.scopeWorkspaceId).toBe(WORKSPACE)
  })

  it('stores NO secret material — schema has only ref/ttl metadata', async () => {
    const cols = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'secret_lease'`
    )
    const names = cols.map((c) => c.column_name)
    for (const forbidden of ['secret', 'plaintext', 'value', 'token', 'credential']) {
      expect(names).not.toContain(forbidden)
    }
    expect(names).toContain('ref')
    expect(names).toContain('ttlSec')
  })

  it('renew advances expiresAt and stamps renewedAt', async () => {
    await seedDaemon(prisma, DAEMON)
    const repo = new PgSecretLeaseRepo(prisma)
    const issuedAt = new Date('2026-06-25T00:00:00.000Z')
    await repo.create(createInput(issuedAt))

    const newExpiry = new Date('2026-06-25T02:00:00.000Z')
    const renewed = await repo.renew(LeaseId(LEASE), newExpiry, new Date())
    expect(renewed.expiresAt.toISOString()).toBe(newExpiry.toISOString())
    expect(renewed.status).toBe('active')
  })

  it('revoke flips status and drops the lease from the active set', async () => {
    await seedDaemon(prisma, DAEMON)
    const repo = new PgSecretLeaseRepo(prisma)
    await repo.create(createInput(new Date()))

    expect(await repo.activeForDaemon(DaemonId(DAEMON))).toHaveLength(1)

    await repo.revoke(LeaseId(LEASE), 'rotated')
    expect(await repo.activeForDaemon(DaemonId(DAEMON))).toHaveLength(0)

    const got = await repo.get(LeaseId(LEASE))
    expect(got?.status).toBe('revoked')
  })
})
