import { createHash, randomUUID } from 'node:crypto'
import {
  MemoryTransactionReceipt,
  utf8Boundary,
  MemoryTransactionReq,
  type MemoryTransactionResult
} from '@agentconnect.md/protocol'
import type { AgentId, OrgId } from '../../domain/ids.js'
import type { AgentMemoryTransactionRepo } from '../ports.js'
import { Prisma } from '../../generated/prisma/client.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import { PgAgentMemoryHistoryRepo } from './agent-memory.repo.js'
import { HISTORY_RETENTION } from '../../agent-memory/limits.js'
import { toHistoryInput } from '../../agent-memory/history.js'

type Tx = Prisma.TransactionClient
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const failure = (
  code: 'CONFLICT' | 'TOO_LARGE' | 'INVALID_ARGUMENT' | 'FORBIDDEN',
  message: string
): MemoryTransactionResult => ({ operation: 'error', code, message })

async function snapshot(tx: Tx, agentId: AgentId, root: string) {
  const totals = await tx.$queryRaw<{ count: bigint; bytes: bigint }[]>(Prisma.sql`
    SELECT count(*) AS "count", COALESCE(sum("size"), 0) AS "bytes" FROM "agent_memory_file"
    WHERE "agentId" = ${agentId}::uuid AND starts_with("path", ${root + '/'}) AND "stagedAt" IS NULL
  `)
  if (Number(totals[0]!.count) > 2048 || Number(totals[0]!.bytes) > 16 * 1024 * 1024) return null
  const rows = await tx.$queryRaw<{ path: string; size: number; mtime: Date; revision: string }[]>(Prisma.sql`
    SELECT "path", "size", "mtime", encode(sha256("content"), 'hex') AS "revision"
    FROM "agent_memory_file" WHERE "agentId" = ${agentId}::uuid AND starts_with("path", ${root + '/'}) AND "stagedAt" IS NULL
    ORDER BY "path" COLLATE "C" LIMIT 2049
  `)
  if (rows.length > 2048 || rows.reduce((sum, row) => sum + row.size, 0) > 16 * 1024 * 1024) return null
  return {
    rows,
    revision: hash(
      JSON.stringify([root, rows.map((row) => [row.path, row.size, row.mtime.toISOString(), row.revision])])
    )
  }
}
function clip(bytes: Uint8Array) {
  const value = Buffer.from(bytes)
  const end = utf8Boundary(value, Math.min(value.length, 4000))
  return { text: value.subarray(0, end).toString('utf8'), truncated: value.length > end }
}

// Same advisory lock as every legacy file primitive; history and receipt failures roll back the file batch too.
export class PgAgentMemoryTransactionRepo implements AgentMemoryTransactionRepo {
  constructor(private readonly db: PrismaLike) {}

  apply(agentId: AgentId, orgId: OrgId, request: MemoryTransactionReq, now: Date): Promise<MemoryTransactionResult> {
    return withAmbientTx(
      this.db,
      async (tx): Promise<MemoryTransactionResult> => {
        // Hold the binding row through publication so switching homes cannot race an already authorized commit.
        const agents = await tx.$queryRaw<{ runtimeOverrides: unknown }[]>(Prisma.sql`
        SELECT "runtimeOverrides" FROM "agent" WHERE "id" = ${agentId}::uuid AND "orgId" = ${orgId} FOR SHARE
      `)
        const config = agents[0]?.runtimeOverrides as { memory?: { provider?: string; home?: string } } | undefined
        if (config?.memory?.provider !== 'managed' || config.memory.home !== 'control-plane')
          return failure('FORBIDDEN', 'the agent no longer has this memory home')
        await tx.$queryRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-memory:${agentId}`}, 0)) IS NULL AS "locked"`
        )
        const requestHash = hash(JSON.stringify(MemoryTransactionReq.parse(request)))
        if (request.operation === 'commit') {
          const prior = await tx.agentMemoryMutation.findUnique({
            where: { agentId_operationId: { agentId, operationId: request.operationId } }
          })
          if (prior) {
            if (prior.requestHash !== requestHash)
              return failure('CONFLICT', 'operation id was already used for a different mutation')
            return { operation: 'commit', receipt: MemoryTransactionReceipt.parse(prior.receipt), replayed: true }
          }
        }
        const before = await snapshot(tx, agentId, request.root)
        if (!before) return failure('TOO_LARGE', 'memory tree exceeds the transaction snapshot budget')
        if (request.operation === 'snapshot') return { operation: 'snapshot', revision: before.revision }
        if (before.revision !== request.expectedRevision)
          return failure('CONFLICT', 'memory tree changed while the mutation was prepared')
        const prepared = []
        for (const change of request.changes) {
          const path = `${request.root}/${change.path}`
          const current = await tx.agentMemoryFile.findUnique({ where: { agentId_path: { agentId, path } } })
          if ((current ? hash(current.content) : null) !== change.expectedRevision || current?.stagedAt)
            return failure('CONFLICT', 'memory entry changed while the mutation was prepared')
          const children = await tx.agentMemoryFile.findFirst({
            where: { agentId, path: { startsWith: path + '/' } },
            select: { path: true }
          })
          if (children) return failure('INVALID_ARGUMENT', 'memory target is a directory')
          const staged =
            change.action === 'put'
              ? await tx.agentMemoryFile.findUnique({
                  where: { agentId_path: { agentId, path: `${request.root}/${change.temp}` } }
                })
              : null
          if (change.action === 'put' && (!staged?.stagedAt || hash(staged.content) !== change.stagedRevision))
            return failure('CONFLICT', 'staged memory content changed or is missing')
          prepared.push({ change, path, current, staged })
        }
        const nextCount =
          before.rows.length +
          prepared.reduce((sum, { current, staged }) => sum + (staged ? 1 : 0) - (current ? 1 : 0), 0)
        const nextBytes =
          before.rows.reduce((sum, row) => sum + row.size, 0) +
          prepared.reduce((sum, { current, staged }) => sum + (staged?.size ?? 0) - (current?.size ?? 0), 0)
        if (nextCount > 2048 || nextBytes > 16 * 1024 * 1024)
          return failure('TOO_LARGE', 'mutation exceeds the memory tree budget')
        // Nothing has changed before every precondition succeeds, including the final member of the batch.
        const files: MemoryTransactionReceipt['files'] = []
        const records = []
        for (const { change, path, current, staged } of prepared) {
          const mtime = new Date(Math.max(now.getTime(), (current?.mtime.getTime() ?? -1) + 1))
          if (staged) {
            if (current) await tx.agentMemoryFile.delete({ where: { agentId_path: { agentId, path } } })
            await tx.agentMemoryFile.update({
              where: { agentId_path: { agentId, path: staged.path } },
              data: { path, stagedAt: null, mtime }
            })
          } else {
            await tx.agentMemoryFile.delete({ where: { agentId_path: { agentId, path } } })
          }
          files.push({
            path: change.path,
            revision: staged ? hash(staged.content) : null,
            mtime: staged ? mtime.toISOString() : null
          })
          const old = current ? clip(current.content) : undefined
          const next = clip(staged?.content ?? new Uint8Array())
          const id = randomUUID()
          records.push(
            toHistoryInput(
              {
                id,
                path: change.path,
                event: current ? (staged ? 'update' : 'delete') : 'add',
                ...(old ? { before: old.text } : {}),
                after: next.text,
                at: mtime.toISOString(),
                scope: 'agent',
                source: request.source,
                ...(old?.truncated || next.truncated ? { truncated: true } : {})
              },
              id
            )
          )
        }
        await new PgAgentMemoryHistoryRepo(tx).append(agentId, orgId, request.root, records, HISTORY_RETENTION)
        const after = await snapshot(tx, agentId, request.root)
        if (!after) throw new Error('committed memory tree exceeds the transaction budget')
        const receipt: MemoryTransactionReceipt = {
          operationId: request.operationId,
          revision: after.revision,
          committedAt: now.toISOString(),
          files
        }
        await tx.agentMemoryMutation.create({
          data: {
            agentId,
            orgId,
            operationId: request.operationId,
            root: request.root,
            requestHash,
            source: request.source,
            sourceTurnId: request.sourceTurnId ?? null,
            committedAt: now,
            receipt
          }
        })
        return { operation: 'commit', receipt, replayed: false }
      },
      { timeout: 15000 }
    )
  }
}
