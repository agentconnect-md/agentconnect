import { Prisma, type McpInvocation } from '../../generated/prisma/client.js'
import type { Clock } from '../../domain/clock.js'
import { systemClock } from '../../domain/clock.js'
import type { PrismaLike } from '../prisma.js'
import {
  MCP_INVOCATION_MAX_RESPONSE_BYTES,
  MCP_INVOCATION_RESPONSE_CACHE_TTL_MS,
  type ClaimMcpInvocationInput,
  type ClaimMcpInvocationResult,
  type CompleteMcpInvocationInput,
  type McpInvocationRecord,
  type McpInvocationRepo,
  type ReapMcpInvocationsResult
} from '../ports.js'

export { MCP_INVOCATION_MAX_RESPONSE_BYTES, MCP_INVOCATION_RESPONSE_CACHE_TTL_MS } from '../ports.js'
export { MCP_INVOCATION_EXECUTION_TIMEOUT_MS } from '../../domain/mcp-invocation.js'

const toRecord = (row: McpInvocation): McpInvocationRecord => ({ ...row })

export class PgMcpInvocationRepo implements McpInvocationRepo {
  constructor(
    private readonly db: PrismaLike,
    private readonly clock: Pick<Clock, 'now'> = systemClock
  ) {}

  async claim(input: ClaimMcpInvocationInput): Promise<ClaimMcpInvocationResult> {
    return this.db.$transaction(async (tx) => {
      // Revoke/rotation takes the same grant-row lock before changing status.
      // Holding it through invocation insertion makes "authorized and claimed"
      // one atomic ordering point: either revocation wins and this is denied, or
      // this claim commits first and owns exactly one execution.
      const [grant] = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT access_grant."id"
        FROM "webchat_mcp_access_grant" AS access_grant
        JOIN "webchat_mcp_delegation" AS authority
          ON authority."id" = access_grant."authorityId"
        JOIN "webchat_conversation" AS conversation
          ON conversation."id" = authority."conversationId"
         AND conversation."delegationGeneration" = authority."generation"
        WHERE access_grant."id" = ${input.grantId}
          AND access_grant."status" = 'active'
          AND access_grant."revokedAt" IS NULL
          AND access_grant."expiresAt" > ${input.now}
          AND authority."conversationId" = ${input.conversationId}
          AND authority."revokedAt" IS NULL
          AND authority."expiresAt" > ${input.now}
        FOR UPDATE OF access_grant
      `)
      if (!grant) return { kind: 'denied' }

      const inserted = await tx.mcpInvocation.createMany({
        data: [
          {
            id: input.invocationId,
            conversationId: input.conversationId,
            grantId: input.grantId,
            requestHash: input.requestHash,
            method: input.method,
            toolName: input.toolName ?? null,
            status: 'running',
            startedAt: input.now,
            createdAt: input.now
          }
        ],
        skipDuplicates: true
      })
      const current = await tx.mcpInvocation.findUnique({ where: { id: input.invocationId } })
      if (!current) return { kind: 'conflict' }
      if (
        current.conversationId !== input.conversationId ||
        current.requestHash !== input.requestHash ||
        current.method !== input.method ||
        current.toolName !== (input.toolName ?? null)
      ) {
        return { kind: 'conflict' }
      }
      return inserted.count === 1
        ? { kind: 'claimed', invocation: toRecord(current) }
        : { kind: 'existing', invocation: toRecord(current) }
    })
  }

  async complete(input: CompleteMcpInvocationInput): Promise<boolean> {
    if (input.responseBytes.byteLength > MCP_INVOCATION_MAX_RESPONSE_BYTES) return false
    const result = await this.db.mcpInvocation.updateMany({
      where: { id: input.invocationId, status: 'running' },
      data: {
        status: input.status,
        responseStatus: input.responseStatus,
        responseBytes: Buffer.from(input.responseBytes),
        completedAt: input.completedAt
      }
    })
    return result.count === 1
  }

  async markAmbiguous(invocationId: string, completedAt: Date): Promise<boolean> {
    const result = await this.db.mcpInvocation.updateMany({
      where: { id: invocationId, status: 'running' },
      data: { status: 'ambiguous', completedAt }
    })
    return result.count === 1
  }

  async markAmbiguousBefore(executionDeadline: Date, completedAt: Date): Promise<number> {
    const result = await this.db.mcpInvocation.updateMany({
      where: { status: 'running', startedAt: { lte: executionDeadline } },
      data: { status: 'ambiguous', completedAt }
    })
    return result.count
  }

  async get(invocationId: string): Promise<McpInvocationRecord | null> {
    const row = await this.db.mcpInvocation.findUnique({ where: { id: invocationId } })
    return row ? toRecord(row) : null
  }

  async reap(now: Date): Promise<ReapMcpInvocationsResult> {
    const ambiguousBefore = new Date(now.getTime() - 5 * 60_000)
    const markedAmbiguous = await this.markAmbiguousBefore(ambiguousBefore, now)
    // The row is the conversation-lifetime idempotency tombstone. Never delete
    // it on a wall-clock TTL: a later grant for the same durable conversation
    // must still be unable to execute this invocation id again. Only evict the
    // bounded response payload; status + request hash remain until conversation
    // lifecycle deletion can cascade the ledger.
    await this.db.mcpInvocation.updateMany({
      where: {
        status: { in: ['succeeded', 'failed', 'ambiguous'] },
        completedAt: { lt: new Date(now.getTime() - MCP_INVOCATION_RESPONSE_CACHE_TTL_MS) },
        responseBytes: { not: null }
      },
      data: { responseBytes: null }
    })
    return { markedAmbiguous, deleted: 0, expiredAssertions: 0 }
  }
}
