import { z } from 'zod'

export const MEMORY_ENTRIES_VERSION = 1 as const
export const MEMORY_ENTRY_FRAME_BYTES = 64 * 1024
export const MEMORY_ENTRY_REF_MAX_LENGTH = 4096
export const MemoryEntryRef = z.string().min(1).max(MEMORY_ENTRY_REF_MAX_LENGTH)
export const MemoryEntryCursor = z.string().min(1).max(2048)
export const MemoryEntryOperation = z.enum(['list', 'get', 'search', 'create', 'update', 'delete', 'history'])
export const MemoryEntryCapabilities = z
  .object({
    version: z.literal(MEMORY_ENTRIES_VERSION),
    operations: z.array(MemoryEntryOperation),
    searchKind: z.enum(['lexical', 'semantic', 'hybrid']).optional(),
    supportedScopes: z.array(z.enum(['agent', 'channel'])),
    writeConsistency: z.enum(['conditional', 'last-write-wins']),
    exactEdit: z.boolean(),
    exactCreate: z.boolean(),
    enumeration: z.enum(['snapshot', 'live', 'unavailable']),
    graph: z.boolean(),
    limits: z.object({ maxItemBytes: z.number().int().positive(), maxPageItems: z.number().int().min(1).max(100) })
  })
  .strict()
export type MemoryEntryCapabilities = z.infer<typeof MemoryEntryCapabilities>

export const MemoryEntrySummary = z
  .object({
    ref: MemoryEntryRef,
    label: z.string().max(512),
    description: z.string().max(1024).optional(),
    format: z.enum(['markdown', 'text']),
    byteSize: z.number().int().nonnegative(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    revision: z.string().max(512).optional(),
    origin: z.enum(['active', 'inherited']),
    editable: z.boolean()
  })
  .strict()
export type MemoryEntrySummary = z.infer<typeof MemoryEntrySummary>

export const MemoryEntryListRequest = z
  .object({
    cursor: MemoryEntryCursor.optional(),
    limit: z.number().int().min(1).max(100).default(20)
  })
  .strict()
export type MemoryEntryListRequest = z.infer<typeof MemoryEntryListRequest>
export const MemoryEntryListResult = z
  .object({
    entries: z.array(MemoryEntrySummary).max(100),
    nextCursor: MemoryEntryCursor.optional(),
    consistency: z.enum(['snapshot', 'live']),
    order: z.enum(['topic', 'backend']),
    catalogRevision: z.string().max(512).optional()
  })
  .strict()
export type MemoryEntryListResult = z.infer<typeof MemoryEntryListResult>

export const MemoryEntryGetRequest = z
  .object({
    ref: MemoryEntryRef,
    cursor: MemoryEntryCursor.optional(),
    maxBytes: z
      .number()
      .int()
      .min(4)
      .max(32 * 1024)
      .default(32 * 1024)
  })
  .strict()
export type MemoryEntryGetRequest = z.infer<typeof MemoryEntryGetRequest>
export const MemoryEntryLink = z
  .object({ label: z.string().max(512), ref: MemoryEntryRef.optional(), exists: z.boolean() })
  .strict()
export const MemoryEntryContent = z
  .object({
    entry: MemoryEntrySummary,
    text: z.string(),
    complete: z.boolean(),
    nextContentCursor: MemoryEntryCursor.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    links: z.array(MemoryEntryLink).max(20).optional(),
    backlinks: z.array(MemoryEntryLink).max(20).optional()
  })
  .strict()
export type MemoryEntryContent = z.infer<typeof MemoryEntryContent>

export const MemoryContextRequest = z
  .object({
    seenRevision: z.string().max(512).optional(),
    maxBytes: z
      .number()
      .int()
      .min(4)
      .max(32 * 1024)
      .default(25_000)
  })
  .strict()
export type MemoryContextRequest = z.infer<typeof MemoryContextRequest>
export const MemoryContextResult = z
  .object({
    catalogRevision: z.string().max(512).optional(),
    freshness: z.enum(['current', 'cached', 'unknown']),
    coverage: z.enum(['complete', 'partial', 'unavailable']),
    overview: z.string()
  })
  .strict()
export type MemoryContextResult = z.infer<typeof MemoryContextResult>

export const MemoryEntryErrorCode = z.enum([
  'UNSUPPORTED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INVALID_ARGUMENT',
  'CONFLICT',
  'STALE_BINDING',
  'CURSOR_EXPIRED',
  'TOO_LARGE',
  'UNAVAILABLE',
  'AMBIGUOUS_WRITE'
])
export type MemoryEntryErrorCode = z.infer<typeof MemoryEntryErrorCode>
