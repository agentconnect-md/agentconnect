import { createMemoryEntryService } from '../../memory/entries/factory.js'
import { MemoryEntriesError } from '../../memory/entries/contract.js'
import type { MemoryEntries } from '../../memory/entries/service.js'
import { DESCRIBE_MEMORY_ENTRIES_ARGS } from '../../memory/entries/tools.js'
import type { MemoryOpsDeps } from './memory.js'
import { layerArgument, memoryScopeFor, memoryWriteCheck, writtenLayer } from './memory.js'
import type { SessionContext } from './context.js'
import type { MemoryScope } from '../../memory/types.js'
import type { MemoryEntryMutationReceipt } from '@agentconnect.md/protocol'

// The `layer` argument picks the scope and never reaches the entry service, whose requests are the console's too.
async function entries(
  ctx: SessionContext,
  deps: MemoryOpsDeps,
  mode: 'read' | 'write',
  args: Record<string, unknown>
) {
  if (!deps.memoryEntryStore) throw new MemoryEntriesError('UNAVAILABLE', 'memory entry service is unavailable')
  const layer = layerArgument(args)
  const scope = await memoryScopeFor(ctx, deps, { mode, ...(layer ? { layer } : {}) })
  const check = memoryWriteCheck(ctx, deps, scope)
  // The people directory's rules ride the write itself, inside its lock (assistant-mode.md §5.17).
  const members = mode === 'write' ? await deps.membersGuard?.(ctx, scope) : undefined
  const service = await createMemoryEntryService({
    provider: deps.memory,
    scope,
    store: deps.memoryEntryStore,
    // Synthetic extraction/Dream bindings keep their constrained legacy writer; research's live shared layer keeps the checked one.
    ...(!ctx.memoryBinding || ctx.memoryBinding.layer !== undefined
      ? {
          write: {
            source: ctx.memoryBinding?.source ?? ('tool' as const),
            canWrite: () => true,
            ...(check ? { check } : {}),
            ...(members ? { guard: members.guard } : {})
          }
        }
      : {}),
    canRead: () => true
  })
  return { service, scope, members }
}
async function call<T>(
  ctx: SessionContext,
  deps: MemoryOpsDeps,
  mode: 'read' | 'write',
  args: Record<string, unknown>,
  action: (service: MemoryEntries, request: Record<string, unknown>, scope: MemoryScope) => Promise<T>
) {
  const { layer: _layer, ...request } = args
  try {
    const { service, scope, members } = await entries(ctx, deps, mode, args)
    const result = await action(service, request, scope)
    await members?.landed()
    return result
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

// A write's receipt also names the layer it landed in.
function mutate(
  ctx: SessionContext,
  deps: MemoryOpsDeps,
  args: Record<string, unknown>,
  action: (service: MemoryEntries, request: Record<string, unknown>) => Promise<MemoryEntryMutationReceipt>
) {
  return call(ctx, deps, 'write', args, async (service, request, scope) => ({
    ...(await action(service, request)),
    ...writtenLayer(ctx, deps, scope)
  }))
}
export async function createMemoryEntry(ctx: SessionContext, args: Record<string, unknown>, deps: MemoryOpsDeps) {
  return mutate(ctx, deps, args, (service, request) => service.create(request))
}
export async function updateMemoryEntry(ctx: SessionContext, args: Record<string, unknown>, deps: MemoryOpsDeps) {
  return mutate(ctx, deps, args, (service, request) => service.update(request))
}
export async function deleteMemoryEntry(ctx: SessionContext, args: Record<string, unknown>, deps: MemoryOpsDeps) {
  return mutate(ctx, deps, args, (service, request) => service.delete(request))
}
