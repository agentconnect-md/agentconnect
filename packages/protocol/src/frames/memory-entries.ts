import { z } from 'zod'
import {
  MemoryEntryCreateRequest,
  MemoryEntryUpdateRequest,
  MemoryEntryDeleteRequest,
  MemoryEntryMutationReceipt,
  MemoryEntryCapabilities,
  MemoryEntryContent,
  MemoryEntryErrorCode,
  MemoryEntryGetRequest,
  MemoryEntryListRequest,
  MemoryEntryListResult,
  MemoryEntrySearchRequest,
  MemoryEntrySearchResult,
  MemoryEntryHistoryRequest,
  MemoryEntryHistoryResult
} from '../memory-entries.js'

export const MEMORY_ENTRIES_V1_FEATURE = 'memory-entries-v1'
// The search operation rides the read frame; a daemon without this feature never receives it.
export const MEMORY_ENTRIES_SEARCH_V1_FEATURE = 'memory-entries-search-v1'
// History rides the read frame too, for console callers only; an older daemon never receives it.
export const MEMORY_ENTRIES_HISTORY_V1_FEATURE = 'memory-entries-history-v1'
const scope = z.object({ agentId: z.string().uuid(), channelKey: z.string().min(1).max(256).optional() })
export const MemoryEntriesReadReq = z.discriminatedUnion('operation', [
  scope.extend({ operation: z.literal('describe') }).strict(),
  scope.extend({ operation: z.literal('list'), request: MemoryEntryListRequest }).strict(),
  scope.extend({ operation: z.literal('get'), request: MemoryEntryGetRequest }).strict(),
  scope.extend({ operation: z.literal('search'), request: MemoryEntrySearchRequest }).strict(),
  scope.extend({ operation: z.literal('history'), request: MemoryEntryHistoryRequest }).strict()
])
export type MemoryEntriesReadReq = z.infer<typeof MemoryEntriesReadReq>
export const MemoryEntriesReadResult = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('describe'), result: MemoryEntryCapabilities }).strict(),
  z.object({ operation: z.literal('list'), result: MemoryEntryListResult }).strict(),
  z.object({ operation: z.literal('get'), result: MemoryEntryContent.nullable() }).strict(),
  z.object({ operation: z.literal('search'), result: MemoryEntrySearchResult }).strict(),
  z.object({ operation: z.literal('history'), result: MemoryEntryHistoryResult }).strict(),
  z.object({ operation: z.literal('error'), code: MemoryEntryErrorCode, message: z.string().max(512) }).strict()
])
export type MemoryEntriesReadResult = z.infer<typeof MemoryEntriesReadResult>

export const MEMORY_ENTRIES_WRITE_V1_FEATURE = 'memory-entries-write-v1'
// JSON bytes including scope/operation; leave envelope headroom below the 256 KiB wire cap.
export const MEMORY_ENTRY_MUTATION_REQUEST_BYTES = 192 * 1024
export const MemoryEntriesWriteReq = z.discriminatedUnion('operation', [
  scope.extend({ operation: z.literal('create'), request: MemoryEntryCreateRequest }).strict(),
  scope.extend({ operation: z.literal('update'), request: MemoryEntryUpdateRequest }).strict(),
  scope.extend({ operation: z.literal('delete'), request: MemoryEntryDeleteRequest }).strict()
])
export type MemoryEntriesWriteReq = z.infer<typeof MemoryEntriesWriteReq>
export function memoryEntryMutationFits(request: MemoryEntriesWriteReq): boolean {
  return new TextEncoder().encode(JSON.stringify(request)).byteLength <= MEMORY_ENTRY_MUTATION_REQUEST_BYTES
}
export const MemoryEntriesWriteResult = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('completed'), result: MemoryEntryMutationReceipt }).strict(),
  z
    .object({
      operation: z.literal('error'),
      code: MemoryEntryErrorCode,
      message: z.string().max(512),
      currentRevision: z.string().max(512).optional()
    })
    .strict()
])
export type MemoryEntriesWriteResult = z.infer<typeof MemoryEntriesWriteResult>
