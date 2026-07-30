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
const WEBCHAT_MCP_DELEGATION_REAP_BATCH_SIZE = 500

export class PgWebchatMcpDelegationRepo implements WebchatMcpDelegationRepo {
  constructor(private readonly db: PrismaLike) {}

  private inTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if ('$transaction' in this.db) return this.db.$transaction(fn)
    return fn(this.db as Prisma.TransactionClient)
  }

  async establish(input: EstablishWebchatMcpDelegationInput): Promise<WebchatMcpDelegationRecord | null> {
    return this.inTransaction(async (tx) => {
      // Global lock order is Agent → Conversation → Delegation. FOR SHARE
      // conflicts with placement UPDATE and agent DELETE while allowing two
      // independent conversations on this agent to establish concurrently.
      const [agent] = await tx.$queryRaw<{ daemonId: string | null }[]>(
        Prisma.sql`SELECT "daemonId" FROM "agent" WHERE "id" = ${input.agentId} FOR SHARE`
      )
      const [conversation] = await tx.$queryRaw<
        { id: string; userId: string; orgId: string; agentId: string }[]
      >(Prisma.sql`
        SELECT "id", "userId", "orgId", "agentId"
        FROM "webchat_conversation"
        WHERE "id" = ${input.conversationId}
        FOR UPDATE
      `)
      if (
        !agent ||
        !conversation ||
        conversation.userId !== input.userId ||
        conversation.orgId !== input.orgId ||
        conversation.agentId !== input.agentId ||
        agent.daemonId !== input.daemonId
      ) {
        return null
      }

      // Preserve the global Agent → Conversation → Delegation lock order. The
      // current row must be re-read under UPDATE lock so revocation and
      // establishment have a single commit order.
      const [latest] = await tx.$queryRaw<WebchatMcpDelegation[]>(Prisma.sql`
        SELECT *
        FROM "webchat_mcp_delegation"
        WHERE "conversationId" = ${input.conversationId}
        ORDER BY "generation" DESC
        LIMIT 1
        FOR UPDATE
      `)
      const sameAuthority =
        latest?.userId === input.userId &&
        latest.orgId === input.orgId &&
        latest.agentId === input.agentId &&
        latest.daemonId === input.daemonId
      if (latest && !latest.revokedAt && latest.expiresAt.getTime() > input.now.getTime() && sameAuthority) {
        if (input.expiresAt.getTime() < latest.expiresAt.getTime()) {
          const shortened = await tx.webchatMcpDelegation.updateMany({
            where: {
              id: latest.id,
              generation: latest.generation,
              revokedAt: null,
              expiresAt: { gt: input.expiresAt }
            },
            data: { expiresAt: input.expiresAt }
          })
          if (shortened.count !== 1) return null
          const current = await tx.webchatMcpDelegation.findUniqueOrThrow({ where: { id: latest.id } })
          if (current.revokedAt !== null) return null
          return toRecord(current)
        }
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

  async getCurrent(delegationId: string): Promise<WebchatMcpDelegationRecord | null> {
    const [row] = await this.db.$queryRaw<WebchatMcpDelegation[]>(Prisma.sql`
      SELECT delegation.*
      FROM "webchat_mcp_delegation" delegation
      JOIN "webchat_conversation" conversation
        ON conversation."id" = delegation."conversationId"
       AND conversation."delegationGeneration" = delegation."generation"
      WHERE delegation."id" = ${delegationId}
    `)
    return row ? toRecord(row) : null
  }

  async reapExpired(expiredBefore: Date): Promise<number> {
    return this.inTransaction(async (tx) => {
      // Delegation → Invocation is the shared mint/reap lock order. Locking
      // candidates first makes the following `none` check a fresh, post-wait
      // statement instead of a stale snapshot that could erase a winning mint.
      // Retained candidates consume a slot in this deterministic batch and are
      // revisited on the next call; work is bounded without skipping newer IDs.
      const candidates = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id"
        FROM "webchat_mcp_delegation"
        WHERE "expiresAt" <= ${expiredBefore}
        ORDER BY "expiresAt", "id"
        LIMIT ${WEBCHAT_MCP_DELEGATION_REAP_BATCH_SIZE}
        FOR UPDATE
      `)
      if (candidates.length === 0) return 0
      const deleted = await tx.webchatMcpDelegation.deleteMany({
        where: {
          id: { in: candidates.map(({ id }) => id) },
          expiresAt: { lte: expiredBefore },
          invocations: { none: {} }
        }
      })
      return deleted.count
    })
  }
}
