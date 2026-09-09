import { createMemoryEntryService } from '../../memory/entries/factory.js'
import { MemoryEntriesError } from '../../memory/entries/contract.js'
import type { MemoryEntries } from '../../memory/entries/service.js'
import { DESCRIBE_MEMORY_ENTRIES_ARGS } from '../../memory/entries/tools.js'
import type { MemoryOpsDeps } from './memory.js'
import { memoryScopeFor } from './memory.js'
import type { SessionContext } from './context.js'

async function entries(ctx: SessionContext, deps: MemoryOpsDeps) {
  if (!deps.memoryEntryStore) throw new MemoryEntriesError('UNAVAILABLE', 'memory entry service is unavailable')
  return createMemoryEntryService({
    provider: deps.memory,
    scope: memoryScopeFor(ctx, deps),
    store: deps.memoryEntryStore,
    canRead: async () => !deps.memoryAccessDecision || (await deps.memoryAccessDecision(ctx, 'read')) === 'allow'
  })
}
async function call(ctx: SessionContext, deps: MemoryOpsDeps, action: (service: MemoryEntries) => Promise<unknown>) {
  try {
    return await action(await entries(ctx, deps))
  } catch (error) {
    if (error instanceof MemoryEntriesError) throw new MemoryEntriesError(error.code, `${error.code}: ${error.message}`)
    throw error
  }
}
export async function describeMemoryEntries(ctx: SessionContext, args: Record<string, unknown>, deps: MemoryOpsDeps) {
  DESCRIBE_MEMORY_ENTRIES_ARGS.parse(args)
  return call(ctx, deps, (service) => service.describe())
}
export async function listMemoryEntries(ctx: SessionContext, args: Record<string, unknown>, deps: MemoryOpsDeps) {
  return call(ctx, deps, (service) => service.list(args))
}
export async function getMemoryEntry(ctx: SessionContext, args: Record<string, unknown>, deps: MemoryOpsDeps) {
  return call(ctx, deps, (service) => service.get(args))
}
