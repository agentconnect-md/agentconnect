import type { MemoryEntriesReadReq, MemoryEntriesReadResult } from '@agentconnect.md/protocol'
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
        canRead: () => canRead(req.agentId)
      })
      switch (req.operation) {
        case 'describe':
          return { operation: 'describe', result: await entries.describe() }
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
