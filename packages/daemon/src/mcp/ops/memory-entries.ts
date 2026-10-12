import { createMemoryEntryService } from '../../memory/entries/factory.js'
import { MemoryEntriesError } from '../../memory/entries/contract.js'
import type { MemoryEntries } from '../../memory/entries/service.js'
import { DESCRIBE_MEMORY_ENTRIES_ARGS } from '../../memory/entries/tools.js'
import type { MemoryOpsDeps } from './memory.js'
import { layerArgument, memoryScopeFor } from './memory.js'
import type { SessionContext } from './context.js'

// The `layer` argument picks the scope and never reaches the entry service, whose requests are the console's too.
async function entries(
  ctx: SessionContext,
  deps: MemoryOpsDeps,
  mode: 'read' | 'write',
  args: Record<string, unknown>
) {
  if (!deps.memoryEntryStore) throw new MemoryEntriesError('UNAVAILABLE', 'memory entry service is unavailable')
  const layer = layerArgument(args)
  return createMemoryEntryService({
    provider: deps.memory,
    scope: await memoryScopeFor(ctx, deps, { mode, ...(layer ? { layer } : {}) }),
    store: deps.memoryEntryStore,
    // Synthetic extraction/Dream bindings keep their constrained legacy writer.
    ...(!ctx.memoryBinding ? { write: { source: 'tool' as const, canWrite: () => true } } : {}),
    canRead: () => true
  })
}
async function call<T>(
  ctx: SessionContext,
  deps: MemoryOpsDeps,
  mode: 'read' | 'write',
  args: Record<string, unknown>,
  action: (service: MemoryEntries, request: Record<string, unknown>) => Promise<T>
) {
  const { layer: _layer, ...request } = args
  try {
    return await action(await entries(ctx, deps, mode, args), request)
  } catch (error) {
    if (error instanceof MemoryEntriesError)
      throw new MemoryEntriesError(error.code, `${error.code}: ${error.message}`, error.currentRevision)
    throw error
  }
}
export async function describeMemoryEntries(ctx: SessionContext, args: Record<string, unknown>, deps: MemoryOpsDeps) {
  DESCRIBE_MEMORY_ENTRIES_ARGS.parse(args)
  return call(ctx, deps, 'read', {}, (service) => service.describe())
}
export async function listMemoryEntries(ctx: SessionContext, args: Record<string, unknown>, deps: MemoryOpsDeps) {
  return call(ctx, deps, 'read', args, (service, request) => service.list(request))
}
export async function getMemoryEntry(ctx: SessionContext, args: Record<string, unknown>, deps: MemoryOpsDeps) {
  return call(ctx, deps, 'read', args, (service, request) => service.get(request))
}
export async function searchMemoryEntries(ctx: SessionContext, args: Record<string, unknown>, deps: MemoryOpsDeps) {
  return call(ctx, deps, 'read', args, (service, request) => service.search(request))
}

export async function createMemoryEntry(ctx: SessionContext, args: Record<string, unknown>, deps: MemoryOpsDeps) {
  return call(ctx, deps, 'write', args, (service, request) => service.create(request))
}
export async function updateMemoryEntry(ctx: SessionContext, args: Record<string, unknown>, deps: MemoryOpsDeps) {
  return call(ctx, deps, 'write', args, (service, request) => service.update(request))
}
export async function deleteMemoryEntry(ctx: SessionContext, args: Record<string, unknown>, deps: MemoryOpsDeps) {
  return call(ctx, deps, 'write', args, (service, request) => service.delete(request))
}
