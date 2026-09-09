import {
  memoryEntryMutationFits,
  MEMORY_ENTRY_MUTATION_REQUEST_BYTES,
  type MemoryEntriesWriteReq,
  type MemoryEntriesWriteResult,
  type MemoryEntriesReadReq,
  type MemoryEntriesReadResult
} from '@agentconnect.md/protocol'
import type { MemoryProvider } from '../memory/provider.js'
import type { LocalStore } from '../store/local-store.js'
import { createMemoryEntryService } from '../memory/entries/factory.js'
import { MemoryEntriesError } from '../memory/entries/contract.js'

export function createMemoryEntriesReader(
  provider: MemoryProvider,
  store: LocalStore,
  canRead: (agentId: string) => boolean
) {
  return async (req: MemoryEntriesReadReq): Promise<MemoryEntriesReadResult> => {
    try {
      const entries = await createMemoryEntryService({
        provider,
        store,
        scope: { agentId: req.agentId, ...(req.channelKey ? { channelKey: req.channelKey } : {}) },
        write: { source: 'console', canWrite: () => canRead(req.agentId) },
        canRead: () => canRead(req.agentId)
      })
      switch (req.operation) {
        case 'describe': {
          const result = await entries.describe()
          return {
            operation: 'describe',
            result: {
              ...result,
              limits: { ...result.limits, maxMutationRequestBytes: MEMORY_ENTRY_MUTATION_REQUEST_BYTES }
            }
          }
        }
        case 'list':
          return { operation: 'list', result: await entries.list(req.request) }
        case 'get':
          return { operation: 'get', result: await entries.get(req.request) }
      }
    } catch (error) {
      if (error instanceof MemoryEntriesError)
        return { operation: 'error', code: error.code, message: error.message.slice(0, 512) }
      return { operation: 'error', code: 'UNAVAILABLE', message: 'memory entry service is unavailable' }
    }
  }
}

export function createMemoryEntriesWriter(
  provider: MemoryProvider,
  store: LocalStore,
  canWrite: (agentId: string) => boolean
) {
  return async (req: MemoryEntriesWriteReq): Promise<MemoryEntriesWriteResult> => {
    try {
      if (!memoryEntryMutationFits(req))
        return { operation: 'error', code: 'TOO_LARGE', message: 'memory mutation exceeds the JSON request byte limit' }
      const entries = await createMemoryEntryService({
        provider,
        store,
        scope: { agentId: req.agentId, ...(req.channelKey ? { channelKey: req.channelKey } : {}) },
        canRead: () => canWrite(req.agentId),
        write: { source: 'console', canWrite: () => canWrite(req.agentId) }
      })
      const result = await entries[req.operation](req.request)
      return { operation: 'completed', result }
    } catch (error) {
      if (error instanceof MemoryEntriesError)
        return {
          operation: 'error',
          code: error.code,
          message: error.message.slice(0, 512),
          ...(error.currentRevision ? { currentRevision: error.currentRevision } : {})
        }
      return {
        operation: 'error',
        code: 'AMBIGUOUS_WRITE',
        message: 'memory mutation outcome is unconfirmed; read current state before retrying'
      }
    }
  }
}
