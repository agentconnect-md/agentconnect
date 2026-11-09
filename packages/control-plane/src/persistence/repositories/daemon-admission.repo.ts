import { Prisma } from '../../generated/prisma/client.js'
import type { DaemonAdmissionRepo, DaemonApproval } from '../ports.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import { lockResourceWriteMemberships } from '../resource-membership-lock.js'
import { lockDaemonMembership } from './member-set.repo.js'

// Pool trust requires the server-recorded TokenReview identity, never advertised capabilities.
export const approvedDaemonWhere = {
  approvalStatus: 'approved',
  OR: [{ orgId: { not: null } }, { orgId: null, clusterIdentity: { not: null }, clusterPodUid: { not: null } }]
} satisfies Prisma.DaemonWhereInput

export function approvedDaemonSql(id: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "daemon" trusted WHERE trusted.id = ${id}
      AND trusted."approvalStatus" = 'approved'
      AND (trusted."orgId" IS NOT NULL OR (trusted."clusterIdentity" IS NOT NULL AND trusted."clusterPodUid" IS NOT NULL))
  )`
}

function refusal(message: string, statusCode = 409): Error {
  return Object.assign(new Error(message), { statusCode })
}

export class PgDaemonAdmissionRepo implements DaemonAdmissionRepo {
  constructor(private readonly db: PrismaLike) {}

  async allowed(daemonIds: readonly string[]): Promise<string[]> {
    if (!daemonIds.length) return []
    const rows = await this.db.daemon.findMany({
      where: { id: { in: [...daemonIds] }, ...approvedDaemonWhere },
      select: { id: true }
    })
    const allowed = new Set(rows.map((row) => row.id))
    return daemonIds.filter((id) => allowed.has(id))
  }

  async connection(input: Parameters<DaemonAdmissionRepo['connection']>[0], now: Date) {
    const daemon = await this.db.daemon.findFirst({
      where: {
        id: input.daemonId,
        orgId: input.orgId,
        sessionEpoch: BigInt(input.sessionEpoch),
        approvalRevision: input.revision,
        ...(input.orgId
          ? {
              apiKeys: {
                some: {
                  id: input.apiKeyId ?? '',
                  principalType: 'daemon',
                  orgId: input.orgId,
                  revokedAt: null,
                  OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
                }
              }
            }
          : { clusterIdentity: { not: null }, clusterPodUid: { not: null } })
      },
      select: { approvalStatus: true }
    })
    return daemon?.approvalStatus ?? 'stale'
  }

  async change(input: Parameters<DaemonAdmissionRepo['change']>[0], now: Date): Promise<DaemonApproval> {
    return withAmbientTx(this.db, async (tx) => {
      if (!input.actorUserId) throw refusal('only an organization owner can do this', 403)
      await lockResourceWriteMemberships(tx, { orgId: input.orgId, actorUserId: input.actorUserId, visibility: 'org' })
      const actor = await tx.membership.findUnique({
        where: { orgId_userId: { orgId: input.orgId, userId: input.actorUserId } },
        select: { role: true }
      })
      if (actor?.role !== 'owner') throw refusal('only an organization owner can do this', 403)
      await lockDaemonMembership(tx, input.daemonId)
      await tx.$queryRaw`SELECT id FROM "daemon" WHERE id = ${input.daemonId}::uuid FOR UPDATE`
      const daemon = await tx.daemon.findUniqueOrThrow({ where: { id: input.daemonId, orgId: input.orgId } })
      if (daemon.approvalRevision !== input.revision) throw refusal('approval changed; refresh and try again')
      if (daemon.approvalStatus === input.status) return this.approval(daemon)
      if (input.status === 'approved') {
        if (daemon.sessionEpoch !== BigInt(input.sessionEpoch) || !daemon.tokenFp || daemon.status !== 'ready')
          throw refusal('connect the daemon and review its current connection')
        const key = await tx.apiKey.findFirst({
          where: {
            id: daemon.tokenFp,
            daemonId: input.daemonId,
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
          }
        })
        if (!key) throw refusal('connect the daemon and review its current connection')
        await tx.apiKey.updateMany({
          where: { daemonId: input.daemonId, id: { not: key.id }, revokedAt: null },
          data: { revokedAt: now }
        })
      }
      const changed = await tx.daemon.update({
        where: { id: input.daemonId, orgId: input.orgId },
        data: {
          approvalStatus: input.status,
          approvalRevision: { increment: 1 },
          approvalSource: 'owner',
          approvalChangedAt: now,
          approvalChangedBy: input.actorUserId
        }
      })
      await tx.auditEvent.create({
        data: {
          kind: 'daemon_approval',
          orgId: input.orgId,
          daemonId: input.daemonId,
          actorUserId: input.actorUserId,
          details: { status: input.status, source: 'owner', revision: changed.approvalRevision }
        }
      })
      return this.approval(changed)
    })
  }

  private approval(row: {
    approvalStatus: DaemonApproval['status']
    approvalRevision: number
    approvalSource: string | null
    approvalChangedAt: Date | null
    approvalChangedBy: string | null
  }): DaemonApproval {
    return {
      status: row.approvalStatus,
      revision: row.approvalRevision,
      source: row.approvalSource,
      changedAt: row.approvalChangedAt,
      changedBy: row.approvalChangedBy
    }
  }
}
