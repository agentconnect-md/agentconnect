/**
 * PgAuditRepo — append-only audit / events feed (design §3.12, §3.14).
 *
 * METADATA ONLY: `details` is a small JSONB of identifiers, never bodies.
 * `append` writes one row; `recent` reads the tail for the dashboard / C7.
 */
import type { Prisma, AuditEvent } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type { AuditRepo, AuditRecord, AuditInput, AuditKind } from '../ports.js'
import { AgentId, DaemonId } from '../../domain/ids.js'

function toRecord(e: AuditEvent): AuditRecord {
  return {
    id: e.id,
    kind: e.kind as AuditKind,
    daemonId: e.daemonId ? DaemonId(e.daemonId) : null,
    agentId: e.agentId ? AgentId(e.agentId) : null,
    message: e.message,
    details: e.details,
    createdAt: e.createdAt
  }
}

export class PgAuditRepo implements AuditRepo {
  constructor(private readonly db: PrismaLike) {}

  async append(input: AuditInput): Promise<AuditRecord> {
    const e = await this.db.auditEvent.create({
      data: {
        kind: input.kind,
        orgId: input.orgId,
        daemonId: input.daemonId,
        agentId: input.agentId,
        sessionId: input.sessionId,
        actorUserId: input.actorUserId,
        frameType: input.frameType,
        frameCorr: input.frameCorr,
        message: input.message,
        details: input.details as Prisma.InputJsonValue | undefined
      }
    })
    return toRecord(e)
  }

  async recent(limit: number): Promise<AuditRecord[]> {
    const rows = await this.db.auditEvent.findMany({
      orderBy: { id: 'desc' },
      take: limit
    })
    return rows.map(toRecord)
  }
}
