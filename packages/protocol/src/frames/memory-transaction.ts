import { z } from 'zod'
import { MemoryEntryErrorCode } from '../memory-entries.js'

export const MEMORY_TRANSACTION_V1_FEATURE = 'memory-transaction-v1'
const digest = z.string().regex(/^[0-9a-f]{64}$/)
export const MemoryTransactionPath = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^./\\\0][^/\\\0]*\.md$/)
const change = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('put'),
      path: MemoryTransactionPath,
      expectedRevision: digest.nullable(),
      temp: z.string().regex(/^\.agentconnect-memory-[0-9a-f-]{36}\.tmp$/),
      stagedRevision: digest
    })
    .strict(),
  z.object({ action: z.literal('delete'), path: MemoryTransactionPath, expectedRevision: digest }).strict()
])
const scope = z.object({ agentId: z.string().uuid(), root: z.string().min(1).max(1024) })
export const MemoryTransactionReq = z.discriminatedUnion('operation', [
  scope.extend({ operation: z.literal('snapshot') }).strict(),
  scope
    .extend({
      operation: z.literal('commit'),
      operationId: z.string().uuid(),
      expectedRevision: digest,
      source: z.enum(['tool', 'console', 'distill', 'dream']),
      sourceTurnId: z.string().uuid().optional(),
      changes: z
        .array(change)
        .min(1)
        .max(2)
        .refine((changes) => new Set(changes.map((change) => change.path)).size === changes.length, 'duplicate paths')
        .refine((changes) => {
          const temps = changes.flatMap((change) => (change.action === 'put' ? [change.temp] : []))
          return new Set(temps).size === temps.length
        }, 'duplicate staging files')
    })
    .strict()
])
export type MemoryTransactionReq = z.infer<typeof MemoryTransactionReq>
export type MemoryTransactionCommit = Extract<MemoryTransactionReq, { operation: 'commit' }>
export const MemoryTransactionReceipt = z
  .object({
    operationId: z.string().uuid(),
    revision: digest,
    committedAt: z.string().datetime(),
    files: z
      .array(
        z
          .object({ path: MemoryTransactionPath, revision: digest.nullable(), mtime: z.string().datetime().nullable() })
          .strict()
      )
      .max(2)
  })
  .strict()
export type MemoryTransactionReceipt = z.infer<typeof MemoryTransactionReceipt>
export const MemoryTransactionResult = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('snapshot'), revision: digest }).strict(),
  z.object({ operation: z.literal('commit'), receipt: MemoryTransactionReceipt, replayed: z.boolean() }).strict(),
  z.object({ operation: z.literal('error'), code: MemoryEntryErrorCode, message: z.string().max(512) }).strict()
])
export type MemoryTransactionResult = z.infer<typeof MemoryTransactionResult>
