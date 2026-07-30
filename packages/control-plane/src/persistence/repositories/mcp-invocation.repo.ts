/**
 * One-time MCP invocation assertion ledger. Every state transition is a
 * status-predicated compare-and-set; responses are retained byte-for-byte.
 */
import { Prisma, type McpInvocation } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type {
  ClaimMcpInvocationInput,
  ClaimMcpInvocationResult,
  CompleteMcpInvocationInput,
  McpInvocationRecord,
  McpInvocationRepo,
  MintMcpInvocationInput,
  MintMcpInvocationResult,
  ReapMcpInvocationsResult
} from '../ports.js'

export const MCP_INVOCATION_MAX_RESPONSE_BYTES = 256 * 1024
export const MCP_INVOCATION_EXECUTION_TIMEOUT_MS = 120_000
export const MCP_INVOCATION_RESPONSE_CACHE_TTL_MS = 15 * 60_000

const isP2002 = (error: unknown): boolean => (error as { code?: string }).code === 'P2002'
const toRecord = (row: McpInvocation): McpInvocationRecord => ({ ...row })

export class PgMcpInvocationRepo implements McpInvocationRepo {
  constructor(private readonly db: PrismaLike) {}

  private inTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if ('$transaction' in this.db) return this.db.$transaction(fn)
    return fn(this.db as Prisma.TransactionClient)
  }

  async mint(input: MintMcpInvocationInput): Promise<MintMcpInvocationResult> {
    try {
      return await this.inTransaction(async (tx) => {
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
              createdAt: input.now
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
      throw error
    }
  }

  async claim(input: ClaimMcpInvocationInput): Promise<ClaimMcpInvocationResult> {
    return this.inTransaction(async (tx) => {
      const claimed = await tx.mcpInvocation.updateMany({
        where: {
          id: input.invocationId,
          assertionHash: input.assertionHash,
          status: 'issued',
          assertionExpires: { gt: input.now }
        },
        data: { status: 'running', startedAt: input.now }
      })
      const invocation = await tx.mcpInvocation.findFirst({
        where: { id: input.invocationId, assertionHash: input.assertionHash }
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
    const completed = await this.db.mcpInvocation.updateMany({
      where: { id: input.invocationId, status: 'running' },
      data: {
        status: input.status,
        responseStatus: input.responseStatus,
        responseBytes: new Uint8Array(input.responseBytes),
        completedAt: input.completedAt
      }
    })
    return completed.count === 1
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
