import { z } from 'zod'
import { CanonicalMemoryRecord, MemoryPluginHistoryEvent, MemoryPluginOperation } from '../memory-plugin.js'

/**
 * Agent memory directory (C→D REQ → REP) — the console's read/write of an agent's
 * long-term memory, and the surface the daemon serves it from.
 *
 * Memory is a DIRECTORY at the agent's ROOT (`<agent-root>/memory/`), OUTSIDE the
 * workspace — so it survives a workspace reset / re-clone and is never committed
 * into a github-workspace repo. It follows the index-plus-topics shape: a lean
 * `MEMORY.md` index (injected into the prompt every session, bounded) plus any
 * number of `<topic>.md` files the agent reads on demand. The agent maintains it
 * via MCP tools; these frames are the third channel — the CP reading/writing it
 * for the console — all pointing at the same directory.
 *
 * The CP stores NO memory content — bytes are pulled live from the owning daemon
 * and proxied to the console, never persisted (body-locality). A not-yet-created
 * file/dir is DATA (`exists:false`), not an error; only an unknown agent or a
 * path-containment violation (`BAD_PAYLOAD`) or an unexpected fs failure
 * (`INTERNAL`) comes back as an `error` frame.
 *
 * - `memory/list`: the topic files in the memory dir (flat; the index + topics).
 * - `memory/read`: one byte slice of a memory file (`path` relative to the memory
 *   dir; default `MEMORY.md`). `limit` is a ceiling — the daemon returns fewer
 *   bytes to keep the JSON-escaped REP under the 256 KiB frame cap and always ends
 *   on a UTF-8 boundary. `nextOffset` is authoritative — do NOT recompute it.
 * - `memory/write`: replace the whole named memory file with `content`.
 * - `memory/history`: page the managed provider's hidden `.history` change log
 *   for one file, newest first. The sidecar itself never appears in `memory/list`.
 */

/** The default file name of the memory index (loaded into the prompt each session). */
export const MEMORY_INDEX = 'MEMORY.md'

/** One entry in a memory-dir listing (name-only; not a path). */
export const MemoryEntry = z.object({
  name: z.string(), // file name relative to the memory dir
  size: z.number().int().nonnegative(),
  mtime: z.string() // RFC3339
})
export type MemoryEntry = z.infer<typeof MemoryEntry>

/** C→D REQ: list the files in the agent's memory dir. */
export const MemoryListReq = z.object({
  agentId: z.string().min(1) // local agent id (NOT a wire UUID)
})
export type MemoryListReq = z.infer<typeof MemoryListReq>

/** D→C REP (corr = the req id): the memory dir's files (or `exists:false`). */
export const MemoryListPage = z.object({
  agentId: z.string(),
  exists: z.boolean(), // false ⇒ the memory dir does not exist yet (NOT an error)
  entries: z.array(MemoryEntry)
})
export type MemoryListPage = z.infer<typeof MemoryListPage>

/** C→D REQ: read one byte slice of a memory file (path relative to the memory dir). */
export const MemoryReadReq = z.object({
  agentId: z.string().min(1), // local agent id (NOT a wire UUID)
  path: z.string().default(MEMORY_INDEX), // memory-dir-relative POSIX path; default the index
  offset: z.number().int().nonnegative().default(0), // byte offset
  limit: z.number().int().positive().max(65536).default(65536) // byte count per slice (64 KiB, see docblock)
})
export type MemoryReadReq = z.infer<typeof MemoryReadReq>

/** D→C REP (corr = the req id): the memory file slice (or `exists:false`). Always utf8 text. */
export const MemoryReadContent = z.object({
  agentId: z.string(),
  path: z.string(),
  exists: z.boolean(), // false ⇒ the file does not exist yet (NOT an error)
  size: z.number().int().nonnegative().optional(), // total file size in bytes
  mtime: z.string().optional(), // RFC3339
  content: z.string().optional(), // utf8 text slice
  offset: z.number().int().nonnegative().optional(), // byte offset this slice starts at
  nextOffset: z.number().int().nonnegative().optional(), // byte offset to request next (offset + bytes in this slice)
  truncated: z.boolean().optional() // true ⇒ nextOffset < size (more bytes remain)
})
export type MemoryReadContent = z.infer<typeof MemoryReadContent>

/** C→D REQ: replace the whole named memory file with `content` (console edit). */
export const MemoryWriteReq = z.object({
  agentId: z.string().min(1), // local agent id (NOT a wire UUID)
  path: z.string().default(MEMORY_INDEX), // memory-dir-relative POSIX path; default the index
  content: z.string(), // full new file content (utf8); '' clears the file
  // Optimistic concurrency: the mtime the writer last read. When present the write
  // fails (CONFLICT) unless the file still has this mtime — so a console edit can't
  // clobber a newer agent write. Omit to force (last-write-wins).
  ifMatchMtime: z.string().optional()
})
export type MemoryWriteReq = z.infer<typeof MemoryWriteReq>

/** D→C REP (corr = the req id): the written state, so the console can refresh. */
export const MemoryWriteOk = z.object({
  agentId: z.string(),
  path: z.string(),
  size: z.number().int().nonnegative(), // bytes written
  mtime: z.string() // RFC3339 of the write
})
export type MemoryWriteOk = z.infer<typeof MemoryWriteOk>

/** One provenance entry from managed memory's retained `.history` sidecar. */
export const MemoryFileHistoryEvent = z
  .object({
    // Optional while legacy JSONL rows are upgraded on their next read/write.
    id: z.string().uuid().optional(),
    path: z.string().min(1).max(255),
    event: z.enum(['add', 'update', 'delete']),
    before: z.string().max(4001).optional(),
    after: z.string().max(4001),
    at: z.string().datetime(),
    scope: z.string().min(1),
    source: z.enum(['tool', 'console', 'distill']),
    truncated: z.boolean().optional()
  })
  .strict()
export type MemoryFileHistoryEvent = z.infer<typeof MemoryFileHistoryEvent>

/** C→D REQ: page the history of one managed memory file, newest first. */
export const MemoryHistoryReq = z
  .object({
    agentId: z.string().min(1),
    path: z.string().min(1).max(255),
    // Opaque to callers. This is a stable event ID, so appends and retention
    // cannot shift older pages.
    cursor: z.string().uuid().optional(),
    // Five worst-case escaped before/after snapshots still fit one wire frame.
    limit: z.number().int().positive().max(5).default(5)
  })
  .strict()
export type MemoryHistoryReq = z.infer<typeof MemoryHistoryReq>

/** D→C REP: one newest-first page from managed memory's change log. */
export const MemoryHistoryPage = z
  .object({
    agentId: z.string().min(1),
    path: z.string().min(1).max(255),
    events: z.array(MemoryFileHistoryEvent).max(5),
    nextCursor: z.string().uuid().optional()
  })
  .strict()
export type MemoryHistoryPage = z.infer<typeof MemoryHistoryPage>

/**
 * Provider-aware memory administration (M-5C).
 *
 * File frames above remain the managed/native compatibility surface. External
 * providers expose canonical records instead. The CP only sees the neutral
 * `files | records | none` shape and capability names; surface discovery never
 * exposes plugin/backend identity, endpoint details, credentials, or raw MCP
 * tool descriptions. A record may carry the profile's bounded canonical
 * provenance, but core never branches on it. Record bodies transit the CP only
 * as correlated request/reply payloads.
 */

const AgentMemoryAdminReq = z.object({ agentId: z.string().min(1) }).strict()
const OptionalRecordCursor = z.string().min(1).max(2048).optional()
const RecordId = z.string().min(1).max(512)
const OperationId = z.string().min(1).max(512)
const RecordMetadata = z.record(z.string(), z.unknown())

/** C→D REQ: discover the provider-neutral administration shape/capabilities. */
export const MemorySurfaceReq = AgentMemoryAdminReq
export type MemorySurfaceReq = z.infer<typeof MemorySurfaceReq>

/** D→C REP: which console shape is available for this agent. */
export const MemorySurfaceInfo = z
  .object({
    agentId: z.string().min(1),
    shape: z.enum(['files', 'records', 'none']),
    capabilities: z.array(MemoryPluginOperation).max(8)
  })
  .strict()
export type MemorySurfaceInfo = z.infer<typeof MemorySurfaceInfo>

/** C→D REQ: semantic search over canonical external-memory records. */
export const MemoryRecordSearchReq = z
  .object({
    agentId: z.string().min(1),
    query: z.string().min(1).max(32768),
    topK: z.number().int().positive().max(20).default(20),
    maxBytes: z.number().int().positive().max(32768).default(32768)
  })
  .strict()
export type MemoryRecordSearchReq = z.infer<typeof MemoryRecordSearchReq>

export const MemoryRecordSearchPage = z
  .object({ agentId: z.string().min(1), records: z.array(CanonicalMemoryRecord).max(20) })
  .strict()
export type MemoryRecordSearchPage = z.infer<typeof MemoryRecordSearchPage>

/** C→D REQ: cursor-page the external store without inventing file semantics. */
export const MemoryRecordListReq = z
  .object({
    agentId: z.string().min(1),
    cursor: OptionalRecordCursor,
    limit: z.number().int().positive().max(20).default(20)
  })
  .strict()
export type MemoryRecordListReq = z.infer<typeof MemoryRecordListReq>

export const MemoryRecordListPage = z
  .object({
    agentId: z.string().min(1),
    records: z.array(CanonicalMemoryRecord).max(20),
    nextCursor: OptionalRecordCursor
  })
  .strict()
export type MemoryRecordListPage = z.infer<typeof MemoryRecordListPage>

export const MemoryRecordGetReq = z.object({ agentId: z.string().min(1), id: RecordId }).strict()
export type MemoryRecordGetReq = z.infer<typeof MemoryRecordGetReq>
export const MemoryRecordGetResult = z
  .object({ agentId: z.string().min(1), record: CanonicalMemoryRecord.nullable() })
  .strict()
export type MemoryRecordGetResult = z.infer<typeof MemoryRecordGetResult>

export const MemoryRecordCreateReq = z
  .object({
    agentId: z.string().min(1),
    operationId: OperationId,
    text: z
      .string()
      .min(1)
      .max(128 * 1024),
    metadata: RecordMetadata.optional()
  })
  .strict()
export type MemoryRecordCreateReq = z.infer<typeof MemoryRecordCreateReq>
export const MemoryRecordCreateResult = z.object({ agentId: z.string().min(1), record: CanonicalMemoryRecord }).strict()
export type MemoryRecordCreateResult = z.infer<typeof MemoryRecordCreateResult>

export const MemoryRecordUpdateReq = z
  .object({
    agentId: z.string().min(1),
    operationId: OperationId,
    id: RecordId,
    text: z
      .string()
      .min(1)
      .max(128 * 1024),
    metadata: RecordMetadata.optional(),
    version: z.string().min(1).max(512).optional()
  })
  .strict()
export type MemoryRecordUpdateReq = z.infer<typeof MemoryRecordUpdateReq>
export const MemoryRecordUpdateResult = MemoryRecordCreateResult
export type MemoryRecordUpdateResult = z.infer<typeof MemoryRecordUpdateResult>

export const MemoryRecordDeleteReq = z
  .object({
    agentId: z.string().min(1),
    operationId: OperationId,
    id: RecordId,
    version: z.string().min(1).max(512).optional()
  })
  .strict()
export type MemoryRecordDeleteReq = z.infer<typeof MemoryRecordDeleteReq>
export const MemoryRecordDeleteResult = z
  .object({ agentId: z.string().min(1), id: RecordId, deleted: z.boolean() })
  .strict()
export type MemoryRecordDeleteResult = z.infer<typeof MemoryRecordDeleteResult>

export const MemoryRecordHistoryReq = z
  .object({
    agentId: z.string().min(1),
    id: RecordId,
    cursor: OptionalRecordCursor,
    limit: z.number().int().positive().max(20).default(20)
  })
  .strict()
export type MemoryRecordHistoryReq = z.infer<typeof MemoryRecordHistoryReq>
export const MemoryRecordHistoryPage = z
  .object({
    agentId: z.string().min(1),
    events: z.array(MemoryPluginHistoryEvent).max(20),
    nextCursor: OptionalRecordCursor
  })
  .strict()
export type MemoryRecordHistoryPage = z.infer<typeof MemoryRecordHistoryPage>
