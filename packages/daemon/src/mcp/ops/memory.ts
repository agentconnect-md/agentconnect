import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { SessionContext } from './context.js'
import {
  optionalBoundedInt,
  optionalObject,
  optionalString,
  parseArgs,
  requiredString,
  requiredStringAllowEmpty
} from './args.js'
import type { MemoryProvider, MemoryScope } from '../../memory/provider.js'
import type { MemoryWriteSource } from '../../memory/store.js'
import { MemoryPathError, MemoryTooLargeError } from '../../memory/store.js'

/** The memory-tool deps. The access gate itself is enforced pre-dispatch in `executeTool`. */
export interface MemoryOpsDeps {
  /** The agent memory provider — backs the `readMemory`/`writeMemory` tools.
   *  Universal (every agent has memory), independent of the platform. */
  memory: MemoryProvider
  /** Session-isolation gate for the explicit memory-tool path, by operation
   *  (#653). Agent memory is shared across users: every session may READ it
   *  (read/search/get), but only a non-isolated session may WRITE it
   *  (write/save/update/delete), so a private DM/A2A turn cannot push its content
   *  into shared memory. Automatic recall is always allowed; post-turn capture and
   *  Dream selection are gated at their own boundaries. Checked at CALL time so a
   *  mid-session policy change takes effect immediately. Absent ⇒ allowed (e.g. in
   *  unit fixtures). */
  memoryAccessAllowed?: (ctx: SessionContext, mode: 'read' | 'write') => boolean | Promise<boolean>
  /** Build the memory scope for a tool call — carries the per-channel folder key
   *  for a channel-scoped agent so tools read/write that channel's memory (#653).
   *  Absent ⇒ agent-level store (unit fixtures). */
  memoryScope?: (ctx: SessionContext) => MemoryScope
}

/** `readMemory` arguments; an omitted `path` reads the MEMORY.md index. */
export const READ_MEMORY_ARGS = z.object({ path: optionalString('path') })

/** `writeMemory` arguments — the two modes are separated by the handler, not the schema. */
export const WRITE_MEMORY_ARGS = z.object({
  path: optionalString('path'),
  content: optionalString('content'),
  oldString: optionalString('oldString'),
  newString: optionalString('newString')
})

/** `searchMemory` arguments (external record memory). */
export const SEARCH_MEMORY_ARGS = z.object({
  query: requiredString('query'),
  topK: optionalBoundedInt('topK', 1, 20),
  maxBytes: optionalBoundedInt('maxBytes', 1, 32_768)
})

/** `saveMemory` arguments. */
export const SAVE_MEMORY_ARGS = z.object({ text: requiredString('text'), metadata: optionalObject('metadata') })

/** `getMemory` arguments. */
export const GET_MEMORY_ARGS = z.object({ id: requiredString('id') })

/** `updateMemory` arguments; `text` may be empty, and `version` enables conditional writes. */
export const UPDATE_MEMORY_ARGS = z.object({
  id: requiredString('id'),
  text: requiredString('text'),
  metadata: optionalObject('metadata'),
  version: optionalString('version')
})

/** `deleteMemory` arguments. */
export const DELETE_MEMORY_ARGS = z.object({ id: requiredString('id'), version: optionalString('version') })

/** Every memory tool's access mode, checked before dispatch: reads are universal, writes
 *  are refused for an isolated session (#653). */
export const MEMORY_TOOL_ACCESS_MODES: Record<string, 'read' | 'write'> = {
  readMemory: 'read',
  writeMemory: 'write',
  searchMemory: 'read',
  getMemory: 'read',
  saveMemory: 'write',
  updateMemory: 'write',
  deleteMemory: 'write'
}

function memoryScopeFor(ctx: SessionContext, deps: MemoryOpsDeps): MemoryScope {
  // A pinned binding wins: a synthetic session's own coordinates would resolve to the
  // wrong store for a channel-scoped agent.
  return ctx.memoryBinding?.scope ?? deps.memoryScope?.(ctx) ?? { agentId: ctx.agentId }
}

/** Provenance for a write made through the shared tool surface. The ordinary
 *  conversational case is `tool`; a distillation- or dream-bound session keeps its own
 *  source so the write ledger — and dream adoption's distill-only rebase — stay honest. */
/** Topics a bound session has written, so `maxTopics` counts DISTINCT files rather than
 *  writes — appending to one topic repeatedly is not new content. It doubles as the
 *  provenance record a dream checks its staged store against. */
const boundTopics = new WeakMap<SessionContext, Set<string>>()

/** Every topic this bound session wrote through the tool. A staged file that is NOT
 *  here did not come from the memory write path — see the dream's staging check. */
export function boundWrittenTopics(ctx: SessionContext): string[] {
  return [...(boundTopics.get(ctx) ?? [])]
}

/** Apply the binding's own limits before a write reaches the store. These carry the
 *  constraints the dream's JSON proposal format used to enforce; the store still
 *  applies path containment and the byte cap underneath. */
function enforceBindingPolicy(ctx: SessionContext, path: string): void {
  const binding = ctx.memoryBinding
  if (!binding) return
  const name = path.replace(/^.*\//, '')
  if (binding.topicPattern && !binding.topicPattern.test(name)) {
    throw new Error(`invalid memory path: "${name}" must match ${String(binding.topicPattern)}`)
  }
  let seen = boundTopics.get(ctx)
  if (!seen) {
    seen = new Set()
    boundTopics.set(ctx, seen)
  }
  if (binding.maxTopics !== undefined && !seen.has(name) && seen.size >= binding.maxTopics) {
    throw new Error(`memory topic limit reached (${binding.maxTopics}) for this session`)
  }
  seen.add(name)
}

function writeSource(ctx: SessionContext): MemoryWriteSource {
  return ctx.memoryBinding?.source ?? 'tool'
}

/** Map the store's typed failures onto the tool-facing messages, verbatim for both file tools. */
function toToolError(err: unknown): never {
  if (err instanceof MemoryPathError) throw new Error(`invalid memory path: ${err.message}`)
  if (err instanceof MemoryTooLargeError) throw new Error(err.message)
  throw err
}

// Memory tools are universal (every agent has memory) and daemon-local — dispatched
// before the platform-gateway gate so an agent with no platform integration works.
export async function readMemory(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: MemoryOpsDeps
): Promise<unknown> {
  const scope = memoryScopeFor(ctx, deps)
  try {
    const path = parseArgs(READ_MEMORY_ARGS, args).path ?? 'MEMORY.md'
    const result = await deps.memory.read(scope, path)
    // One hop of the `[[name]]` graph, returned as its OWN fields — never spliced into
    // `content`, which the agent may hand straight back to `writeMemory`.
    const related = await deps.memory.neighbors?.(scope, path).catch(() => undefined)
    if (!related || (related.links.length === 0 && related.backlinks.length === 0)) return result
    return {
      ...result,
      ...(related.links.length > 0 ? { links: related.links } : {}),
      ...(related.backlinks.length > 0 ? { backlinks: related.backlinks } : {})
    }
  } catch (err) {
    toToolError(err)
  }
}

export async function writeMemory(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: MemoryOpsDeps
): Promise<unknown> {
  const scope = memoryScopeFor(ctx, deps)
  try {
    // writeMemory — exactly one of two modes: full-write (`content`) OR targeted edit
    // (`oldString` + `newString`). Validate the pair ATOMICALLY: either edit field present
    // selects edit mode, and BOTH are then required (so a stray `newString` isn't silently
    // ignored, and an omitted `newString` isn't silently treated as a deletion — deletion
    // must be an explicit `newString: ""`).
    const parsed = parseArgs(WRITE_MEMORY_ARGS, args)
    const path = parsed.path ?? 'MEMORY.md'
    enforceBindingPolicy(ctx, path)
    const { oldString, newString, content } = parsed
    const editMode = oldString !== undefined || newString !== undefined
    if (editMode) {
      if (content !== undefined)
        throw new Error('writeMemory: pass EITHER `content` (full write) OR `oldString`+`newString` (edit), not both')
      if (oldString === undefined || newString === undefined)
        throw new Error(
          'writeMemory: an edit needs BOTH `oldString` and `newString` (pass `newString: ""` to delete the matched text)'
        )
      // str-replace: read → replace the single exact occurrence → write the whole file back.
      // Writes are serialized per agent turn, so a read-modify-write race is not a concern.
      const current = (await deps.memory.read(scope, path)).content
      const occurrences = oldString === '' ? 0 : current.split(oldString).length - 1
      if (occurrences === 0)
        throw new Error(
          'writeMemory: `oldString` was not found in the target memory file. Call `readMemory` and copy it from ' +
            'the current `content`; the attempted text may be stale or copied from non-memory session context.'
        )
      if (occurrences > 1)
        throw new Error(
          'writeMemory: `oldString` occurs multiple times — include more surrounding context to make it unique'
        )
      const updated = current.replace(oldString, newString)
      return await deps.memory.write(scope, path, updated, undefined, writeSource(ctx))
    }
    const full = parseArgs(requiredStringAllowEmpty('content'), content)
    return await deps.memory.write(scope, path, full, undefined, writeSource(ctx))
  } catch (err) {
    toToolError(err)
  }
}

/** The record-memory surface for this call. External-memory tools are daemon-local but
 *  operate on canonical records instead of pretending the plugin has files. The current
 *  provider is re-resolved on EVERY call so a stale session tool cannot cross a provider or
 *  capability change. The trusted agent scope is always ctx.agentId. */
function recordSurface(ctx: SessionContext, deps: MemoryOpsDeps) {
  const surface = deps.memory.adminSurfaceForAgent?.(ctx.agentId) ?? deps.memory.adminSurface()
  if (!surface || surface.shape !== 'records') throw new Error('record memory is not available for this agent')
  const scope = memoryScopeFor(ctx, deps)
  const requireCapability = (operation: 'recall' | 'create' | 'get' | 'update' | 'delete'): void => {
    if (!surface.capabilities.has(operation)) throw new Error(`record memory does not support ${operation}`)
  }
  return { surface, scope, requireCapability }
}

export async function searchMemory(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: MemoryOpsDeps
): Promise<unknown> {
  const { surface, scope, requireCapability } = recordSurface(ctx, deps)
  requireCapability('recall')
  const { query, topK, maxBytes } = parseArgs(SEARCH_MEMORY_ARGS, args)
  const records = await surface.search(scope, {
    turnId: randomUUID(),
    query,
    topK: topK ?? 5,
    maxBytes: maxBytes ?? 8_192,
    timeoutMs: 3_000
  })
  return { records }
}

export async function saveMemory(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: MemoryOpsDeps
): Promise<unknown> {
  const { surface, scope, requireCapability } = recordSurface(ctx, deps)
  requireCapability('create')
  const { text, metadata } = parseArgs(SAVE_MEMORY_ARGS, args)
  const record = await surface.create(scope, {
    operationId: randomUUID(),
    text,
    ...(metadata ? { metadata } : {})
  })
  return { record }
}

export async function getMemory(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: MemoryOpsDeps
): Promise<unknown> {
  const { surface, scope, requireCapability } = recordSurface(ctx, deps)
  requireCapability('get')
  return { record: await surface.get(scope, parseArgs(GET_MEMORY_ARGS, args).id) }
}

export async function updateMemory(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: MemoryOpsDeps
): Promise<unknown> {
  const { surface, scope, requireCapability } = recordSurface(ctx, deps)
  requireCapability('update')
  const { id, text, metadata, version } = parseArgs(UPDATE_MEMORY_ARGS, args)
  const record = await surface.update(scope, {
    operationId: randomUUID(),
    id,
    text,
    ...(metadata ? { metadata } : {}),
    ...(version ? { version } : {})
  })
  return { record }
}

export async function deleteMemory(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: MemoryOpsDeps
): Promise<unknown> {
  const { surface, scope, requireCapability } = recordSurface(ctx, deps)
  requireCapability('delete')
  const { id, version } = parseArgs(DELETE_MEMORY_ARGS, args)
  return {
    id,
    deleted: await surface.delete(scope, {
      operationId: randomUUID(),
      id,
      ...(version ? { version } : {})
    })
  }
}
