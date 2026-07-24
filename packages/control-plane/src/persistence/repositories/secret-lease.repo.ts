/**
 * PgSecretLeaseRepo — lease metadata (design §3.10, §3.14).
 *
 * NO plaintext: only the Vault/KMS `ref` + TTL are persisted. `create` opens an
 * active lease; `renew` advances `expiresAt`; `revoke` flips status (dropping it
 * from `activeForDaemon`, which feeds `register/ok.leases[]`).
 */
import type { Platform } from '@agentconnect.md/protocol'
import type { SecretLease } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type { SecretLeaseRepo, LeaseRecord, CreateLeaseInput, LeaseStatus } from '../ports.js'
import { toDbPlatform } from '../platform.js'
import { DaemonId, LeaseId } from '../../domain/ids.js'

function toRecord(l: SecretLease): LeaseRecord {
  return {
    id: LeaseId(l.id),
    daemonId: DaemonId(l.daemonId),
    scopePlatform: l.scopePlatform as Platform,
    scopeWorkspaceId: l.scopeWorkspaceId,
    ref: l.ref,
    ttlSec: l.ttlSec,
    renewBeforeSec: l.renewBeforeSec,
    status: l.status as LeaseStatus,
    issuedAt: l.issuedAt,
    expiresAt: l.expiresAt
  }
}

export class PgSecretLeaseRepo implements SecretLeaseRepo {
  constructor(private readonly db: PrismaLike) {}

  async create(input: CreateLeaseInput): Promise<LeaseRecord> {
    const l = await this.db.secretLease.create({
      data: {
        id: input.leaseId,
        daemonId: input.daemonId,
        scopePlatform: toDbPlatform(input.scope.platform),
        scopeWorkspaceId: input.scope.workspaceId,
        ref: input.ref,
        ttlSec: input.ttlSec,
        renewBeforeSec: input.renewBeforeSec ?? 60,
        status: 'active',
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt
      }
    })
    return toRecord(l)
  }

  async renew(leaseId: LeaseId, expiresAt: Date, at: Date): Promise<LeaseRecord> {
    const l = await this.db.secretLease.update({
      where: { id: leaseId },
      data: { expiresAt, renewedAt: at, status: 'active' }
    })
    return toRecord(l)
  }

  async revoke(leaseId: LeaseId, reason: string): Promise<void> {
    await this.db.secretLease.update({
      where: { id: leaseId },
      data: { status: 'revoked', revokedReason: reason }
    })
  }

  async activeForDaemon(daemonId: DaemonId): Promise<LeaseRecord[]> {
    const rows = await this.db.secretLease.findMany({
      where: { daemonId, status: 'active' },
      orderBy: { issuedAt: 'asc' }
    })
    return rows.map(toRecord)
  }

  async get(leaseId: LeaseId): Promise<LeaseRecord | null> {
    const l = await this.db.secretLease.findUnique({ where: { id: leaseId } })
    return l ? toRecord(l) : null
  }
}
