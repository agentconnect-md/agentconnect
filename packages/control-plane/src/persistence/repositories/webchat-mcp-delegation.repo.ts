/**
 * Durable browser-conversation MCP authority. Establishment serializes on the
 * conversation row so concurrent tabs converge on one generation.
 */
import { Prisma, type WebchatMcpDelegation } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type {
  EstablishWebchatMcpDelegationInput,
  RevokeWebchatMcpDelegationInput,
  WebchatMcpDelegationRecord,
  WebchatMcpDelegationRepo
} from '../ports.js'

const toRecord = (row: WebchatMcpDelegation): WebchatMcpDelegationRecord => ({ ...row })

export class PgWebchatMcpDelegationRepo implements WebchatMcpDelegationRepo {
  constructor(private readonly db: PrismaLike) {}

  private inTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if ('$transaction' in this.db) return this.db.$transaction(fn)
    return fn(this.db as Prisma.TransactionClient)
  }

  async establish(input: EstablishWebchatMcpDelegationInput): Promise<WebchatMcpDelegationRecord | null> {
    return this.inTransaction(async (tx) => {
      // This durable owner row is the allocation lock for every generation.
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "webchat_conversation" WHERE "id" = ${input.conversationId} FOR UPDATE`
      )
      const conversation = await tx.webchatConversation.findFirst({
        where: {
          id: input.conversationId,
          userId: input.userId,
          orgId: input.orgId,
          agentId: input.agentId
        },
        select: { id: true }
      })
      if (!conversation) return null

      const latest = await tx.webchatMcpDelegation.findFirst({
        where: { conversationId: input.conversationId },
        orderBy: { generation: 'desc' }
      })
      const sameAuthority =
        latest?.userId === input.userId &&
        latest.orgId === input.orgId &&
        latest.agentId === input.agentId &&
        latest.daemonId === input.daemonId
      if (latest && !latest.revokedAt && latest.expiresAt.getTime() > input.now.getTime() && sameAuthority) {
        return toRecord(latest)
      }

      if (latest && !latest.revokedAt) {
        const expired = latest.expiresAt.getTime() <= input.now.getTime()
        await tx.webchatMcpDelegation.updateMany({
          where: { id: latest.id, generation: latest.generation, revokedAt: null },
          data: {
            revokedAt: input.now,
            revokedReason: expired ? 'expired' : sameAuthority ? 'rotated' : 'placement_changed'
          }
        })
      }

      const owner = await tx.webchatConversation.update({
        where: { id: input.conversationId },
        data: { delegationGeneration: { increment: 1 } },
        select: { delegationGeneration: true }
      })
      const created = await tx.webchatMcpDelegation.create({
        data: {
          conversationId: input.conversationId,
          generation: owner.delegationGeneration,
          userId: input.userId,
          orgId: input.orgId,
          agentId: input.agentId,
          daemonId: input.daemonId,
          createdAt: input.now,
          expiresAt: input.expiresAt
        }
      })
      return toRecord(created)
    })
  }

  async revoke(input: RevokeWebchatMcpDelegationInput): Promise<boolean> {
    const exactAuthority = {
      id: input.delegationId,
      conversationId: input.conversationId,
      generation: input.generation,
      userId: input.userId,
      orgId: input.orgId,
      agentId: input.agentId,
      daemonId: input.daemonId
    }
    const changed = await this.db.webchatMcpDelegation.updateMany({
      where: { ...exactAuthority, revokedAt: null },
      data: { revokedAt: input.revokedAt, revokedReason: input.reason }
    })
    if (changed.count === 1) return true
    return (
      (await this.db.webchatMcpDelegation.count({
        where: { ...exactAuthority, revokedAt: { not: null } }
      })) === 1
    )
  }

  async get(delegationId: string): Promise<WebchatMcpDelegationRecord | null> {
    const row = await this.db.webchatMcpDelegation.findUnique({ where: { id: delegationId } })
    return row ? toRecord(row) : null
  }

  async reapExpired(expiredBefore: Date): Promise<number> {
    const deleted = await this.db.webchatMcpDelegation.deleteMany({
      where: {
        expiresAt: { lte: expiredBefore },
        invocations: { none: {} }
      }
    })
    return deleted.count
  }
}
