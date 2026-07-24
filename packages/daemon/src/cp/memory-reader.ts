/**
 * `MemoryReader` — the provider-aware router answering the CP's memory admin
 * REQs. Managed/native keep the file surface; external providers expose
 * canonical records; `none` exposes neither. Bodies live only on the daemon and
 * transit the CP as correlated replies (§1/§12).
 *
 * Path containment stays inside each file provider (`resolveInMemoryDir` for
 * managed, nested containment for native): an escape throws `MemoryPathError` →
 * `BAD_PAYLOAD`. An unknown agent is also `BAD_PAYLOAD`; a not-yet-created
 * file/dir is data (`exists:false`), not an error. Frame-size safety mirrors the
 * workspace reader: the read slice is bounded by the *encoded* reply size and
 * ends on a UTF-8 boundary. Never log memory contents.
 */
import { randomUUID } from 'node:crypto'
import type {
  MemoryListReq,
  MemoryListPage,
  MemoryReadReq,
  MemoryReadContent,
  MemoryWriteReq,
  MemoryWriteOk,
  MemorySurfaceReq,
  MemorySurfaceInfo,
  MemoryRecordSearchReq,
  MemoryRecordSearchPage,
  MemoryRecordListReq,
  MemoryRecordListPage,
  MemoryRecordGetReq,
  MemoryRecordGetResult,
  MemoryRecordCreateReq,
  MemoryRecordCreateResult,
  MemoryRecordUpdateReq,
  MemoryRecordUpdateResult,
  MemoryRecordDeleteReq,
  MemoryRecordDeleteResult,
  MemoryRecordHistoryReq,
  MemoryRecordHistoryPage,
  MemoryPluginOperation
} from '@agentconnect.md/protocol'
import { fitToBudget, utf8Boundary } from './wire-slice.js'
import {
  listMemory,
  readMemoryFile,
  writeMemoryFile,
  MemoryPathError,
  MemoryTooLargeError,
  MemoryConflictError
} from '../agents/memory.js'
import type { MemoryAdminSurface, MemoryScope } from '../agents/memory-provider.js'

/** Unknown-agent violation → `BAD_PAYLOAD` on the wire (path escapes surface as
 *  MemoryPathError from agents/memory.ts, mapped the same way by the dispatcher). */
export class MemoryViolationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryViolationError'
  }
}

export { MemoryPathError, MemoryTooLargeError, MemoryConflictError }

export interface MemoryReader {
  list(req: MemoryListReq): Promise<MemoryListPage>
  read(req: MemoryReadReq): Promise<MemoryReadContent>
  write(req: MemoryWriteReq): Promise<MemoryWriteOk>
  surface(req: MemorySurfaceReq): Promise<MemorySurfaceInfo>
  search(req: MemoryRecordSearchReq): Promise<MemoryRecordSearchPage>
  recordList(req: MemoryRecordListReq): Promise<MemoryRecordListPage>
  recordGet(req: MemoryRecordGetReq): Promise<MemoryRecordGetResult>
  recordCreate(req: MemoryRecordCreateReq): Promise<MemoryRecordCreateResult>
  recordUpdate(req: MemoryRecordUpdateReq): Promise<MemoryRecordUpdateResult>
  recordDelete(req: MemoryRecordDeleteReq): Promise<MemoryRecordDeleteResult>
  recordHistory(req: MemoryRecordHistoryReq): Promise<MemoryRecordHistoryPage>
}

export interface AgentMemoryAdminResolver {
  adminSurfaceForAgent(agentId: string): MemoryAdminSurface
}

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === code
}

/** `agentDirByAgent` resolves an agent id → its root dir (which holds `memory/`),
 *  or undefined for an unknown agent. */
export function createMemoryReader(
  agentDirByAgent: (agentId: string) => string | undefined,
  provider?: AgentMemoryAdminResolver
): MemoryReader {
  function dirFor(agentId: string): string {
    const dir = agentDirByAgent(agentId)
    if (!dir) throw new MemoryViolationError(`unknown agent "${agentId}"`)
    return dir
  }

  function adminSurface(agentId: string): MemoryAdminSurface {
    // Validate agent identity independently of provider selection. A resolver's
    // default provider fallback must not turn an unknown id into an admin surface.
    dirFor(agentId)
    return (
      provider?.adminSurfaceForAgent(agentId) ?? {
        shape: 'files',
        list: async (scope) => listMemory(dirFor(scope.agentId)),
        read: async (scope, path) => ({ path, content: await readMemoryFile(dirFor(scope.agentId), path) }),
        write: async (scope, path, content, ifMatch, source) => {
          const result = await writeMemoryFile(dirFor(scope.agentId), path, content, ifMatch, source)
          return { ok: true, path, ...result }
        }
      }
    )
  }

  function requireFileSurface(agentId: string) {
    const surface = adminSurface(agentId)
    if (!surface || surface.shape !== 'files') {
      throw new MemoryViolationError('this memory provider does not expose files')
    }
    return surface
  }

  function requireRecordSurface(agentId: string, operation: MemoryPluginOperation) {
    const surface = adminSurface(agentId)
    if (!surface || surface.shape !== 'records') {
      throw new MemoryViolationError('this memory provider does not expose records')
    }
    if (!surface.capabilities.has(operation)) {
      throw new MemoryViolationError(`this memory provider does not support ${operation}`)
    }
    return surface
  }

  const scopeFor = (agentId: string): MemoryScope => ({ agentId })

  return {
    async list(req) {
      const surface = requireFileSurface(req.agentId)
      const files = await surface.list(scopeFor(req.agentId))
      // Providers return [] for a missing/empty store; the console shows that as
      // `exists:false`, preserving the legacy file-frame contract.
      return { agentId: req.agentId, exists: files.length > 0, entries: files }
    },

    async read(req) {
      const surface = requireFileSurface(req.agentId)
      const scope = scopeFor(req.agentId)
      const notFound = { agentId: req.agentId, path: req.path, exists: false }

      const files = await surface.list(scope)
      const entry = files.find((candidate) => candidate.name === req.path)
      if (!entry) {
        // `list` alone cannot distinguish a valid absent name from a containment
        // violation. Ask the provider to validate the path before returning
        // not-found; directories retain the legacy not-found behavior.
        try {
          await surface.read(scope, req.path)
        } catch (error) {
          if (isErrno(error, 'EISDIR')) return notFound
          throw error
        }
        return notFound
      }

      const full = Buffer.from((await surface.read(scope, req.path)).content, 'utf8')
      const size = full.length
      const want = Math.min(req.limit, Math.max(0, size - req.offset))
      const slice = full.subarray(req.offset, req.offset + want)
      // Cut on a UTF-8 boundary, then shrink so the JSON-escaped reply fits the
      // frame budget. `nextOffset` is authoritative — not a recount of `content`.
      const { end, content } = fitToBudget(slice, utf8Boundary(slice, slice.length))
      const nextOffset = req.offset + end
      return {
        agentId: req.agentId,
        path: req.path,
        exists: true,
        size,
        mtime: entry.mtime,
        content,
        offset: req.offset,
        nextOffset,
        truncated: nextOffset < size
      }
    },

    async write(req) {
      const surface = requireFileSurface(req.agentId)
      const { size, mtime } = await surface.write(
        scopeFor(req.agentId),
        req.path,
        req.content,
        req.ifMatchMtime,
        'console'
      )
      return { agentId: req.agentId, path: req.path, size, mtime }
    },

    async surface(req) {
      const surface = adminSurface(req.agentId)
      return {
        agentId: req.agentId,
        shape: surface?.shape ?? 'none',
        capabilities: surface?.shape === 'records' ? [...surface.capabilities] : []
      }
    },

    async search(req) {
      const surface = requireRecordSurface(req.agentId, 'recall')
      const records = await surface.search(scopeFor(req.agentId), {
        turnId: randomUUID(),
        query: req.query,
        topK: req.topK,
        maxBytes: req.maxBytes,
        timeoutMs: 3_000
      })
      return { agentId: req.agentId, records }
    },

    async recordList(req) {
      const surface = requireRecordSurface(req.agentId, 'list')
      const page = await surface.list(scopeFor(req.agentId), {
        ...(req.cursor ? { cursor: req.cursor } : {}),
        limit: req.limit
      })
      return {
        agentId: req.agentId,
        records: page.records,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
      }
    },

    async recordGet(req) {
      const surface = requireRecordSurface(req.agentId, 'get')
      return { agentId: req.agentId, record: await surface.get(scopeFor(req.agentId), req.id) }
    },

    async recordCreate(req) {
      const surface = requireRecordSurface(req.agentId, 'create')
      const record = await surface.create(scopeFor(req.agentId), {
        operationId: req.operationId,
        text: req.text,
        ...(req.metadata ? { metadata: req.metadata } : {})
      })
      return { agentId: req.agentId, record }
    },

    async recordUpdate(req) {
      const surface = requireRecordSurface(req.agentId, 'update')
      const record = await surface.update(scopeFor(req.agentId), {
        operationId: req.operationId,
        id: req.id,
        text: req.text,
        ...(req.metadata ? { metadata: req.metadata } : {}),
        ...(req.version ? { version: req.version } : {})
      })
      return { agentId: req.agentId, record }
    },

    async recordDelete(req) {
      const surface = requireRecordSurface(req.agentId, 'delete')
      const deleted = await surface.delete(scopeFor(req.agentId), {
        operationId: req.operationId,
        id: req.id,
        ...(req.version ? { version: req.version } : {})
      })
      return { agentId: req.agentId, id: req.id, deleted }
    },

    async recordHistory(req) {
      const surface = requireRecordSurface(req.agentId, 'history')
      const page = await surface.history(scopeFor(req.agentId), {
        id: req.id,
        ...(req.cursor ? { cursor: req.cursor } : {}),
        limit: req.limit
      })
      return { agentId: req.agentId, events: page.events, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
    }
  }
}
