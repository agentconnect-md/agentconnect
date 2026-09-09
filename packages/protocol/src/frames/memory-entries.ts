import { z } from 'zod'
import {
  MemoryEntryCapabilities,
  MemoryEntryContent,
  MemoryEntryErrorCode,
  MemoryEntryGetRequest,
  MemoryEntryListRequest,
  MemoryEntryListResult
} from '../memory-entries.js'

export const MEMORY_ENTRIES_V1_FEATURE = 'memory-entries-v1'
const scope = z.object({ agentId: z.string().uuid(), channelKey: z.string().min(1).max(256).optional() })
export const MemoryEntriesReadReq = z.discriminatedUnion('operation', [
  scope.extend({ operation: z.literal('describe') }).strict(),
  scope.extend({ operation: z.literal('list'), request: MemoryEntryListRequest }).strict(),
  scope.extend({ operation: z.literal('get'), request: MemoryEntryGetRequest }).strict()
])
export type MemoryEntriesReadReq = z.infer<typeof MemoryEntriesReadReq>
export const MemoryEntriesReadResult = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('describe'), result: MemoryEntryCapabilities }).strict(),
  z.object({ operation: z.literal('list'), result: MemoryEntryListResult }).strict(),
  z.object({ operation: z.literal('get'), result: MemoryEntryContent.nullable() }).strict(),
  z.object({ operation: z.literal('error'), code: MemoryEntryErrorCode, message: z.string().max(512) }).strict()
])
export type MemoryEntriesReadResult = z.infer<typeof MemoryEntriesReadResult>
