import {
  memoryEntryMutationFits,
  MEMORY_ENTRY_MUTATION_REQUEST_BYTES,
  type MemoryEntriesWriteReq,
  type MemoryEntriesWriteResult,
  type MemoryEntriesReadReq,
  type MemoryEntriesReadResult
} from '@agentconnect.md/protocol'
import type { MemoryProvider, MemoryScope } from '../memory/provider.js'
import type { LocalStore } from '../store/local-store.js'
import { createMemoryEntryService } from '../memory/entries/factory.js'
import { MemoryEntriesError } from '../memory/entries/contract.js'
import { MemoryHomeUnavailableError } from '../memory/fs.js'
import { organizationFileRefusal } from '../memory/organization-files.js'
import { MEMBERS_DIRECTORY_FILE } from '../memory/members-directory.js'

/** The console changes the people directory only by clearing an entry (assistant-mode.md §5.17). */
export const MEMBERS_CONSOLE_EDIT_REFUSED = `${MEMBERS_DIRECTORY_FILE} is changed in the console only by clearing an entry`

const consoleMembersGuard = async (topic: string): Promise<void> => {
  if (topic === MEMBERS_DIRECTORY_FILE) throw new MemoryEntriesError('FORBIDDEN', MEMBERS_CONSOLE_EDIT_REFUSED)
}

// The Memory page's scope: the organization record is on the Knowledge page, so its names are left out here.
const consoleScope = (req: { agentId: string; channelKey?: string | undefined }): MemoryScope => ({
  agentId: req.agentId,
  ...(req.channelKey ? { channelKey: req.channelKey } : {}),
  withoutRecord: true
})

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
        scope: consoleScope(req),
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
        case 'search':
          return { operation: 'search', result: await entries.search(req.request) }
        case 'history':
          return { operation: 'history', result: await entries.history(req.request) }
      }
    } catch (error) {
      // An unreachable home is refused on the wire with its reason, so the console can wake a sleeping sandbox.
      if (error instanceof MemoryHomeUnavailableError) throw error
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
        scope: consoleScope(req),
        canRead: () => canWrite(req.agentId),
        // A console write with no place layer lands in the shared one, where the organization files keep their shapes.
        write: {
          source: 'console',
          canWrite: () => canWrite(req.agentId),
          ...(req.channelKey ? {} : { check: organizationFileRefusal, guard: consoleMembersGuard })
        }
      })
      const result = await entries[req.operation](req.request)
      return { operation: 'completed', result }
    } catch (error) {
      // The home is resolved before any write leaves this daemon, so this refusal is never an uncertain outcome.
      if (error instanceof MemoryHomeUnavailableError) throw error
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
