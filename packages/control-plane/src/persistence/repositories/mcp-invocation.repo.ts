/**
 * One-time MCP invocation assertion ledger. Every state transition is a
 * status-predicated compare-and-set; responses are retained byte-for-byte.
 */
import { Prisma, type McpInvocation } from '../../generated/prisma/client.js'
import { systemClock, type Clock } from '../../domain/clock.js'
import { canView } from '../../domain/visibility.js'
import type { PrismaLike } from '../prisma.js'
import {
  MCP_INVOCATION_MAX_RESPONSE_BYTES,
  MCP_INVOCATION_RESPONSE_CACHE_TTL_MS,
  type ClaimMcpInvocationInput,
  type ClaimMcpInvocationResult,
  type CompleteMcpInvocationInput,
  type McpInvocationRecord,
  type McpInvocationRepo,
  type MintMcpInvocationInput,
  type MintMcpInvocationResult,
  type OrgMemberRole,
  type ReapMcpInvocationsResult
} from '../ports.js'
import { MCP_INVOCATION_EXECUTION_TIMEOUT_MS } from '../../domain/mcp-invocation.js'

export { MCP_INVOCATION_MAX_RESPONSE_BYTES, MCP_INVOCATION_RESPONSE_CACHE_TTL_MS } from '../ports.js'
export { MCP_INVOCATION_EXECUTION_TIMEOUT_MS } from '../../domain/mcp-invocation.js'

const isP2002 = (error: unknown): boolean => (error as { code?: string }).code === 'P2002'
const isP2003 = (error: unknown): boolean => (error as { code?: string }).code === 'P2003'
const toRecord = (row: McpInvocation): McpInvocationRecord => ({ ...row })

export class PgMcpInvocationRepo implements McpInvocationRepo {
  constructor(
    private readonly db: PrismaLike,
    private readonly clock: Pick<Clock, 'now'> = systemClock
  ) {}

  private inTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if ('$transaction' in this.db) return this.db.$transaction(fn)
    return fn(this.db as Prisma.TransactionClient)
  }

  async mint(input: MintMcpInvocationInput): Promise<MintMcpInvocationResult> {
    try {
      return await this.inTransaction(async (tx) => {
        // Delegation → Invocation is the shared mint/reap lock order. SHARE
        // permits sibling mints but conflicts with revocation, expiry shortening,
        // and delegation/cascade deletion.
        const parent = await tx.$queryRaw<{ id: string }[]>(
          Prisma.sql`
            SELECT "id"
            FROM "webchat_mcp_delegation"
            WHERE "id" = ${input.delegationId}
              AND "revokedAt" IS NULL
              AND "expiresAt" > ${input.mintedAt}
              AND "expiresAt" >= ${input.assertionExpires}
            FOR SHARE
          `
        )
        if (parent.length === 0) return { kind: 'denied' }

        // Conflict-tolerant allocation keeps a concurrent duplicate from
        // aborting the transaction before we can inspect the winning row.
        const inserted = await tx.mcpInvocation.createMany({
          data: [
            {
              id: input.invocationId,
              delegationId: input.delegationId,
              assertionHash: input.assertionHash,
              requestHash: input.requestHash,
              method: input.method,
              toolName: input.toolName ?? null,
              assertionExpires: input.assertionExpires,
              createdAt: input.mintedAt
            }
          ],
          skipDuplicates: true
        })

        // Serialize assertion rotation and state observation for this public id.
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "mcp_invocation" WHERE "id" = ${input.invocationId} FOR UPDATE`)
        const current = await tx.mcpInvocation.findUnique({ where: { id: input.invocationId } })
        if (!current) return { kind: 'conflict' }

        const sameBinding =
          current.delegationId === input.delegationId &&
          current.requestHash === input.requestHash &&
          current.method === input.method &&
          current.toolName === (input.toolName ?? null)
        if (!sameBinding) return { kind: 'conflict' }
        if (inserted.count === 1) return { kind: 'issued', invocation: toRecord(current) }
        if (current.status !== 'issued') return { kind: 'existing', invocation: toRecord(current) }

        const rotated = await tx.mcpInvocation.updateMany({
          where: {
            id: input.invocationId,
            delegationId: input.delegationId,
            requestHash: input.requestHash,
            method: input.method,
            toolName: input.toolName ?? null,
            status: 'issued'
          },
          data: {
            assertionHash: input.assertionHash,
            assertionExpires: input.assertionExpires
          }
        })
        if (rotated.count !== 1) {
          const winner = await tx.mcpInvocation.findUniqueOrThrow({ where: { id: input.invocationId } })
          return { kind: 'existing', invocation: toRecord(winner) }
        }
        const invocation = await tx.mcpInvocation.findUniqueOrThrow({ where: { id: input.invocationId } })
        return { kind: 'issued', invocation: toRecord(invocation) }
      })
    } catch (error) {
      // A caller-supplied digest that collides with another public invocation
      // is a conflict, never a reason to expose database details.
      if (isP2002(error)) return { kind: 'conflict' }
      // A parent/cascade delete that wins before the parent lock is an ordinary
      // loss of authority, not an internal persistence failure.
      if (isP2003(error)) return { kind: 'denied' }
      throw error
    }
  }

  async claim(input: ClaimMcpInvocationInput): Promise<ClaimMcpInvocationResult> {
    return this.inTransaction(async (tx) => {
      // This is the durable authorization snapshot for both first execution
      // and every replay. The lock order matches authority writers:
      // Membership → Agent → Conversation → Delegation → Preset → Invocation.
      // In particular, member removal prunes Agent.sharedWith only after
      // deleting Membership, so taking Membership first avoids lock inversion.
      const [membership] = await tx.$queryRaw<{ role: string }[]>(Prisma.sql`
        SELECT "role"
        FROM "membership"
        WHERE "orgId" = ${input.orgId}
          AND "userId" = ${input.userId}
        FOR SHARE
      `)
      if (!membership || !isOrgMemberRole(membership.role)) return { kind: 'denied' }

      const [agent] = await tx.$queryRaw<
        {
          id: string
          orgId: string
          daemonId: string | null
          createdByUserId: string | null
          visibility: 'org' | 'restricted'
          sharedWith: string[]
        }[]
      >(Prisma.sql`
        SELECT "id", "orgId", "daemonId", "createdByUserId", "visibility", "sharedWith"
        FROM "agent"
        WHERE "id" = ${input.agentId}
        FOR SHARE
      `)
      if (
        !agent ||
        agent.orgId !== input.orgId ||
        agent.daemonId !== input.daemonId ||
        !canView(agent, { userId: input.userId, role: membership.role })
      ) {
        return { kind: 'denied' }
      }

      const conversation = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id"
        FROM "webchat_conversation"
        WHERE "id" = ${input.conversationId}
          AND "userId" = ${input.userId}
          AND "orgId" = ${input.orgId}
          AND "agentId" = ${input.agentId}
          AND "delegationGeneration" = ${input.generation}
        FOR SHARE
      `)
      if (conversation.length === 0) return { kind: 'denied' }

      // SHARE conflicts with direct revocation, expiry shortening, generation
      // rotation, and cascade deletion. Check the complete immutable binding so
      // caller-supplied ids can never transplant an assertion to another parent.
      const [parent] = await tx.$queryRaw<{ id: string; expiresAt: Date }[]>(Prisma.sql`
        SELECT "id", "expiresAt"
        FROM "webchat_mcp_delegation"
        WHERE "id" = ${input.delegationId}
          AND "generation" = ${input.generation}
          AND "conversationId" = ${input.conversationId}
          AND "userId" = ${input.userId}
          AND "orgId" = ${input.orgId}
          AND "agentId" = ${input.agentId}
          AND "daemonId" = ${input.daemonId}
          AND "revokedAt" IS NULL
        FOR SHARE
      `)
      if (!parent) return { kind: 'denied' }

      const [preset] = await tx.$queryRaw<{ agentId: string | null }[]>(Prisma.sql`
        SELECT "agentId"
        FROM "preset_agent"
        WHERE "orgId" = ${input.orgId}
          AND "preset" = 'general'
        FOR SHARE
      `)
      if (!preset || preset.agentId !== input.agentId) return { kind: 'denied' }

      const claimNowMs = this.clock.now()
      const claimNow = new Date(claimNowMs)
      if (!Number.isFinite(claimNowMs) || !Number.isFinite(claimNow.getTime())) {
        return { kind: 'denied' }
      }
      if (parent.expiresAt.getTime() <= claimNowMs) return { kind: 'denied' }

      const claimed = await tx.mcpInvocation.updateMany({
        where: {
          id: input.invocationId,
          delegationId: input.delegationId,
          assertionHash: input.assertionHash,
          status: 'issued',
          assertionExpires: { gt: claimNow }
        },
        data: { status: 'running', startedAt: claimNow }
      })
      const invocation = await tx.mcpInvocation.findFirst({
        where: {
          id: input.invocationId,
          delegationId: input.delegationId,
          assertionHash: input.assertionHash
        }
      })
      if (claimed.count === 1 && invocation) return { kind: 'claimed', invocation: toRecord(invocation) }
      if (!invocation) return { kind: 'not_found' }
      if (invocation.status === 'issued') return { kind: 'expired' }
      return { kind: 'existing', invocation: toRecord(invocation) }
    })
  }

  async complete(input: CompleteMcpInvocationInput): Promise<boolean> {
    if (input.responseBytes.byteLength > MCP_INVOCATION_MAX_RESPONSE_BYTES) {
      throw new RangeError('MCP invocation response exceeds the 256 KiB persistence limit')
    }
    const completedAtMs = input.completedAt.getTime()
    if (!Number.isFinite(completedAtMs)) return false
    const completed = await this.db.mcpInvocation.updateMany({
      where: {
        id: input.invocationId,
        status: 'running',
        // Strict boundary: a completion at startedAt + 120s is already late.
        startedAt: { gt: new Date(completedAtMs - MCP_INVOCATION_EXECUTION_TIMEOUT_MS) }
      },
      data: {
        status: input.status,
        responseStatus: input.responseStatus,
        responseBytes: new Uint8Array(input.responseBytes),
        completedAt: input.completedAt
      }
    })
    return completed.count === 1
  }

  async markAmbiguous(invocationId: string, completedAt: Date): Promise<boolean> {
    const marked = await this.db.mcpInvocation.updateMany({
      where: { id: invocationId, status: 'running' },
      data: { status: 'ambiguous', completedAt }
    })
    return marked.count === 1
  }

  async markAmbiguousBefore(executionDeadline: Date, completedAt: Date): Promise<number> {
    const marked = await this.db.mcpInvocation.updateMany({
      where: {
        status: 'running',
        startedAt: { lte: executionDeadline }
      },
      data: { status: 'ambiguous', completedAt }
    })
    return marked.count
  }

  async get(invocationId: string): Promise<McpInvocationRecord | null> {
    const row = await this.db.mcpInvocation.findUnique({ where: { id: invocationId } })
    return row ? toRecord(row) : null
  }

  async getByAssertionHash(assertionHash: string): Promise<McpInvocationRecord | null> {
    const row = await this.db.mcpInvocation.findUnique({ where: { assertionHash } })
    return row ? toRecord(row) : null
  }

  async reap(now: Date): Promise<ReapMcpInvocationsResult> {
    return this.inTransaction(async (tx) => {
      const executionDeadline = new Date(now.getTime() - MCP_INVOCATION_EXECUTION_TIMEOUT_MS)
      const terminalBefore = new Date(now.getTime() - MCP_INVOCATION_RESPONSE_CACHE_TTL_MS)
      const marked = await tx.mcpInvocation.updateMany({
        where: {
          status: 'running',
          startedAt: { lte: executionDeadline }
        },
        data: { status: 'ambiguous', completedAt: now }
      })
      const deleted = await tx.mcpInvocation.deleteMany({
        where: {
          OR: [
            { status: 'issued', assertionExpires: { lte: now } },
            {
              status: { in: ['succeeded', 'failed', 'ambiguous'] },
              completedAt: { lte: terminalBefore }
            }
          ]
        }
      })
      return { markedAmbiguous: marked.count, deleted: deleted.count }
    })
  }
}

function isOrgMemberRole(role: string): role is OrgMemberRole {
  return role === 'owner' || role === 'collaborator' || role === 'viewer'
}
