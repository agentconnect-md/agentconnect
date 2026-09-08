import type { MemoryProvider, MemoryScope } from '../types.js'
import type { LocalStore } from '../../store/local-store.js'
import { MemoryEntriesError } from './contract.js'
import { MemoryEntries, memoryDigest } from './service.js'
import { memoryContinuations, memoryEntryTokens } from './state.js'

// Projection-specific authorization runs before resolving the live provider, on every call.
export async function createMemoryEntryService(input: {
  provider: MemoryProvider
  scope: MemoryScope
  store: LocalStore
  canRead: () => boolean | Promise<boolean>
}): Promise<MemoryEntries> {
  const scope = { ...input.scope }
  return new MemoryEntries(
    async () => {
      if (!(await input.canRead())) throw new MemoryEntriesError('FORBIDDEN', 'memory read access is not allowed')
      const view = await input.provider.entryView?.(scope)
      if (view) return view
      return {
        identity: memoryDigest(['no-entry-view', scope.agentId]),
        capabilities: {
          version: 1,
          operations: [],
          supportedScopes: [],
          writeConsistency: 'last-write-wins',
          exactCreate: false,
          exactEdit: false,
          enumeration: 'unavailable',
          graph: false,
          limits: { maxPageItems: 100, maxItemBytes: 256_000 }
        },
        async context() {
          return { freshness: 'unknown', coverage: 'unavailable', overview: '' }
        }
      }
    },
    await memoryEntryTokens(input.store),
    memoryContinuations(input.store, scope.agentId)
  )
}
