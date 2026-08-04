import { Prisma, type WebchatMcpOperation } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import {
  WEBCHAT_MCP_OPERATION_MAX_RESPONSE_BYTES,
  type CompleteWebchatMcpOperationInput,
  type CreateWebchatMcpOperationInput,
  type CreateWebchatMcpOperationResult,
  type ReapWebchatMcpOperationsResult,
  type WebchatMcpOperationRecord,
  type WebchatMcpOperationRepo
} from '../ports.js'

const TERMINAL = ['completed', 'failed', 'ambiguous', 'stale'] as const
const RESPONSE_RETENTION_MS = 24 * 60 * 60_000

const toRecord = (row: WebchatMcpOperation): WebchatMcpOperationRecord => ({
  ...row,
  canonicalArguments: row.canonicalArguments
})

export class PgWebchatMcpOperationRepo implements WebchatMcpOperationRepo {
  constructor(private readonly db: PrismaLike) {}

  async createOrReplay(input: CreateWebchatMcpOperationInput): Promise<CreateWebchatMcpOperationResult> {
    return this.db.$transaction(
      async (tx) => {
        const [liveGrant] = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
          SELECT access_grant."id"
          FROM "webchat_mcp_access_grant" AS access_grant
          JOIN "webchat_mcp_delegation" AS authority
            ON authority."id" = access_grant."authorityId"
          JOIN "webchat_conversation" AS conversation
            ON conversation."id" = authority."conversationId"
           AND conversation."delegationGeneration" = authority."generation"
           AND conversation."userId" = authority."userId"
           AND conversation."orgId" = authority."orgId"
           AND conversation."agentId" = authority."agentId"
          JOIN "membership" AS member
            ON member."orgId" = authority."orgId"
           AND member."userId" = authority."userId"
          JOIN "agent" AS delegated_agent
            ON delegated_agent."id" = authority."agentId"
           AND delegated_agent."orgId" = authority."orgId"
           AND delegated_agent."daemonId" = authority."daemonId"
           AND (
             delegated_agent."visibility" = 'org'
             OR authority."userId" = ANY(delegated_agent."sharedWith")
           )
          JOIN "preset_agent" AS preset
            ON preset."orgId" = authority."orgId"
           AND preset."preset" = 'general'
           AND preset."status" = 'created'
           AND preset."agentId" = authority."agentId"
          -- Current-session fence: only the conversation's transactionally
          -- maintained pointer identifies the installed ACP session ('endedAt'
          -- is stamped after every turn and cannot mean "replaced"). Locking
          -- conversation + session serializes with pointer moves and visibility
          -- changes.
          JOIN "session_meta" AS active_session
            ON active_session."id" = conversation."currentSessionId"
           AND active_session."agentId" = authority."agentId"
           AND active_session."platform" = 'webchat'
           AND active_session."channel" = authority."conversationId"::text
           AND active_session."visibility" = 'private'
          WHERE access_grant."id" = ${input.grantId}
            AND access_grant."status" = 'active'
            AND access_grant."revokedAt" IS NULL
            AND access_grant."expiresAt" > ${input.now}
            AND authority."conversationId" = ${input.conversationId}
            AND authority."generation" = ${input.authorityGeneration}
            AND authority."userId" = ${input.userId}
            AND authority."revokedAt" IS NULL
            AND authority."expiresAt" > ${input.now}
          FOR UPDATE OF access_grant, authority, conversation, member, delegated_agent, preset, active_session
        `)
        if (!liveGrant) return { kind: 'denied' }

        const [receipt] = await tx.$queryRaw<
          { requestHash: string; operationId: string; supersededAt: Date | null }[]
        >(Prisma.sql`
          SELECT "requestHash", "operationId", "supersededAt"
          FROM "webchat_mcp_transport_receipt"
          WHERE "grantId" = ${input.grantId}
            AND "jsonRpcRequestId" = ${input.jsonRpcRequestId}
          FOR UPDATE
        `)
        if (receipt) {
          const operation = await tx.webchatMcpOperation.findUnique({ where: { id: receipt.operationId } })
          if (!operation || operation.conversationId !== input.conversationId) return { kind: 'conflict' }
          if (receipt.requestHash === input.requestHash) return { kind: 'replayed', operation: toRecord(operation) }
          if (!TERMINAL.includes(operation.status as (typeof TERMINAL)[number]) || receipt.supersededAt) {
            return { kind: 'conflict' }
          }
        }

        const inserted = await tx.$executeRaw(Prisma.sql`
          INSERT INTO "webchat_mcp_operation" (
            "id", "conversationId", "createdAuthorityGeneration", "sourceGrantId", "userId",
            "toolName", "canonicalArguments", "intentHash", "status", "createdAt", "confirmationExpiresAt"
          ) VALUES (
            gen_random_uuid(), ${input.conversationId}::uuid, ${input.authorityGeneration}, ${input.grantId}::uuid,
            ${input.userId}, ${input.toolName}, ${JSON.stringify(input.canonicalArguments)}::jsonb, ${input.intentHash},
            'awaiting_confirmation', ${input.now}, ${input.confirmationExpiresAt}
          )
          ON CONFLICT ("conversationId", "intentHash") WHERE "status" = 'awaiting_confirmation' DO NOTHING
        `)
        const operation = await tx.webchatMcpOperation.findFirst({
          where: {
            conversationId: input.conversationId,
            intentHash: input.intentHash,
            status: 'awaiting_confirmation'
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
        })
        if (!operation) return { kind: 'conflict' }

        if (receipt) {
          await tx.webchatMcpTransportReceipt.update({
            where: { grantId_jsonRpcRequestId: { grantId: input.grantId, jsonRpcRequestId: input.jsonRpcRequestId } },
            data: {
              conversationId: input.conversationId,
              requestHash: input.requestHash,
              operationId: operation.id,
              createdAt: input.now,
              supersededAt: input.now
            }
          })
        } else {
          await tx.webchatMcpTransportReceipt.create({
            data: {
              grantId: input.grantId,
              jsonRpcRequestId: input.jsonRpcRequestId,
              conversationId: input.conversationId,
              requestHash: input.requestHash,
              operationId: operation.id,
              createdAt: input.now
            }
          })
        }
        return {
          kind: inserted === 1 ? 'created' : 'coalesced',
          operation: toRecord(operation)
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )
  }

  async get(operationId: string): Promise<WebchatMcpOperationRecord | null> {
    const row = await this.db.webchatMcpOperation.findUnique({ where: { id: operationId } })
    return row ? toRecord(row) : null
  }

  async listPending(conversationId: string, userId: string, now: Date): Promise<WebchatMcpOperationRecord[]> {
    const rows = await this.db.webchatMcpOperation.findMany({
      where: { conversationId, userId, status: 'awaiting_confirmation', confirmationExpiresAt: { gt: now } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    })
    return rows.map(toRecord)
  }

  async claimForApproval(input: {
    operationId: string
    conversationId: string
    userId: string
    executionAttemptId: string
    claimedAt: Date
    recoveryDeadline: Date
  }): Promise<WebchatMcpOperationRecord | null> {
    return this.db.$transaction(
      async (tx) => {
        // This is the approval ordering point. Authority rotation/revocation and
        // approval lock the same rows, so only one can commit as current.
        const [eligible] = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
          SELECT operation."id"
          FROM "webchat_mcp_operation" AS operation
          JOIN "webchat_mcp_access_grant" AS access_grant
            ON access_grant."id" = operation."sourceGrantId"
          JOIN "webchat_mcp_delegation" AS authority
            ON authority."id" = access_grant."authorityId"
          JOIN "webchat_conversation" AS conversation
            ON conversation."id" = operation."conversationId"
           AND conversation."delegationGeneration" = operation."createdAuthorityGeneration"
           AND conversation."delegationGeneration" = authority."generation"
           AND conversation."userId" = operation."userId"
           AND conversation."userId" = authority."userId"
           AND conversation."orgId" = authority."orgId"
           AND conversation."agentId" = authority."agentId"
          JOIN "membership" AS member
            ON member."orgId" = authority."orgId"
           AND member."userId" = authority."userId"
          JOIN "agent" AS delegated_agent
            ON delegated_agent."id" = authority."agentId"
           AND delegated_agent."orgId" = authority."orgId"
           AND delegated_agent."daemonId" = authority."daemonId"
           AND (
             delegated_agent."visibility" = 'org'
             OR authority."userId" = ANY(delegated_agent."sharedWith")
           )
          JOIN "preset_agent" AS preset
            ON preset."orgId" = authority."orgId"
           AND preset."preset" = 'general'
           AND preset."status" = 'created'
           AND preset."agentId" = authority."agentId"
          -- Same current-session fence as createOrReplay: the pointer, not
          -- endedAt ordering, names the installed session; the row locks below
          -- serialize approval against pointer moves and visibility widening.
          JOIN "session_meta" AS active_session
            ON active_session."id" = conversation."currentSessionId"
           AND active_session."agentId" = authority."agentId"
           AND active_session."platform" = 'webchat'
           AND active_session."channel" = authority."conversationId"::text
           AND active_session."visibility" = 'private'
          WHERE operation."id" = ${input.operationId}::uuid
            AND operation."conversationId" = ${input.conversationId}::uuid
            AND operation."userId" = ${input.userId}
            AND operation."status" = 'awaiting_confirmation'
            AND operation."confirmationExpiresAt" > ${input.claimedAt}
            AND access_grant."status" = 'active'
            AND access_grant."revokedAt" IS NULL
            AND access_grant."expiresAt" > ${input.claimedAt}
            AND authority."revokedAt" IS NULL
            AND authority."expiresAt" > ${input.claimedAt}
          FOR UPDATE OF operation, access_grant, authority, conversation, member, delegated_agent, preset, active_session
        `)
        if (!eligible) {
          await tx.webchatMcpOperation.updateMany({
            where: {
              id: input.operationId,
              conversationId: input.conversationId,
              userId: input.userId,
              status: 'awaiting_confirmation'
            },
            data: { status: 'stale', completedAt: input.claimedAt }
          })
          return null
        }
        const updated = await tx.webchatMcpOperation.updateMany({
          where: { id: input.operationId, status: 'awaiting_confirmation' },
          data: {
            status: 'executing',
            executionAttemptId: input.executionAttemptId,
            claimedAt: input.claimedAt,
            recoveryDeadline: input.recoveryDeadline
          }
        })
        if (updated.count !== 1) return null
        const row = await tx.webchatMcpOperation.findUnique({ where: { id: input.operationId } })
        return row ? toRecord(row) : null
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )
  }

  async complete(input: CompleteWebchatMcpOperationInput): Promise<boolean> {
    if (input.boundedResponse.byteLength > WEBCHAT_MCP_OPERATION_MAX_RESPONSE_BYTES) return false
    const result = await this.db.webchatMcpOperation.updateMany({
      where: { id: input.operationId, status: 'executing', executionAttemptId: input.executionAttemptId },
      data: {
        status: input.status,
        boundedResponse: Buffer.from(input.boundedResponse),
        completedAt: input.completedAt
      }
    })
    return result.count === 1
  }

  async markAmbiguous(operationId: string, executionAttemptId: string, completedAt: Date): Promise<boolean> {
    const result = await this.db.webchatMcpOperation.updateMany({
      where: { id: operationId, status: 'executing', executionAttemptId },
      data: { status: 'ambiguous', completedAt }
    })
    return result.count === 1
  }

  async deny(operationId: string, conversationId: string, userId: string, completedAt: Date): Promise<boolean> {
    const result = await this.db.webchatMcpOperation.updateMany({
      where: { id: operationId, conversationId, userId, status: 'awaiting_confirmation' },
      data: { status: 'failed', completedAt }
    })
    return result.count === 1
  }

  async reap(now: Date): Promise<ReapWebchatMcpOperationsResult> {
    const ambiguous = await this.db.webchatMcpOperation.updateMany({
      where: { status: 'executing', recoveryDeadline: { lte: now } },
      data: { status: 'ambiguous', completedAt: now }
    })
    const stale = await this.db.webchatMcpOperation.updateMany({
      where: { status: 'awaiting_confirmation', confirmationExpiresAt: { lte: now } },
      data: { status: 'stale', completedAt: now }
    })
    const evicted = await this.db.webchatMcpOperation.updateMany({
      where: {
        status: { in: [...TERMINAL] },
        completedAt: { lt: new Date(now.getTime() - RESPONSE_RETENTION_MS) },
        boundedResponse: { not: null }
      },
      data: { boundedResponse: null }
    })
    return { markedAmbiguous: ambiguous.count, markedStale: stale.count, evictedResponses: evicted.count }
  }
}
