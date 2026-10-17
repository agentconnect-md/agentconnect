import type { LocalStore } from '../../store/local-store.js'
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
import { MEMORY_LAYER_CHOICES, type MemoryLayerChoice } from '../../memory/types.js'
import type { MemoryWriteSource } from '../../memory/store.js'
import { MemoryPathError, MemoryTooLargeError } from '../../memory/store.js'
import { MEMORY_LAYER_NOTES } from '../../memory/entries/tools.js'
import { organizationFileRefusal, type MemoryTextCheck } from '../../memory/organization-files.js'

/** The memory-tool deps. */
export interface MemoryOpsDeps {
  /** The agent memory provider — backs the `readMemory`/`writeMemory` tools.
   *  Universal (every agent has memory), independent of the platform. */
  memoryEntryStore?: LocalStore
  memory: MemoryProvider
  /** One memory tool call's scope: the session's layers or the one `layer` names, rejecting one this turn may not use. */
  memoryScope?: (ctx: SessionContext, call: MemoryToolCall) => MemoryScope | Promise<MemoryScope>
}

/** What a memory tool call asks of the layers: whether it reads or writes, and the layer it names. */
export interface MemoryToolCall {
  mode: 'read' | 'write'
  layer?: MemoryLayerChoice
}

/** A stray key here is almost always the sibling file tool's argument; refuse it by name (#1921). */
const unexpectedKeys: { error: z.core.$ZodErrorMap } = {
  error: (issue) =>
    issue.code === 'unrecognized_keys'
      ? `unexpected argument${issue.keys.length > 1 ? 's' : ''}: ${issue.keys.join(', ')}`
      : undefined
}

const layerArg = z
  .enum(MEMORY_LAYER_CHOICES, { error: 'argument layer must be "shared", "person" or "here"' })
  .optional()

/** `readMemory` arguments; an omitted `path` reads the MEMORY.md index. */
export const READ_MEMORY_ARGS = z.strictObject({ path: optionalString('path'), layer: layerArg }, unexpectedKeys)

/** `writeMemory` arguments — the two modes are separated by the handler, not the schema. */
export const WRITE_MEMORY_ARGS = z.strictObject(
  {
    path: optionalString('path'),
    content: optionalString('content'),
    oldString: optionalString('oldString'),
    newString: optionalString('newString'),
    layer: layerArg
  },
  unexpectedKeys
)

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

/** Every memory tool's access mode: what the layer rule and a read-only pass judge it by. */
export const MEMORY_TOOL_ACCESS_MODES: Record<string, 'read' | 'write'> = {
  describeMemoryEntries: 'read',
  listMemoryEntries: 'read',
  getMemoryEntry: 'read',
  searchMemoryEntries: 'read',
  createMemoryEntry: 'write',
  updateMemoryEntry: 'write',
  deleteMemoryEntry: 'write',
  readMemory: 'read',
  writeMemory: 'write',
  searchMemory: 'read',
  getMemory: 'read',
  saveMemory: 'write',
  updateMemory: 'write',
  deleteMemory: 'write'
}

/** The scope of one memory tool call; a pinned binding (a distillation or a dream) is its own store and names no layer. */
export async function memoryScopeFor(
  ctx: SessionContext,
  deps: MemoryOpsDeps,
  call: MemoryToolCall
): Promise<MemoryScope> {
  if (ctx.memoryBinding && call.layer !== undefined)
    throw new Error('argument layer is not available in this memory session')
  return { ...(ctx.memoryBinding?.scope ?? (await deps.memoryScope?.(ctx, call)) ?? { agentId: ctx.agentId }) }
}

/** The layer a successful write landed in and what it means to a person; a pinned binding or a memory without layers names none. */
export function writtenLayer(
  ctx: SessionContext,
  deps: MemoryOpsDeps,
  scope: MemoryScope
): { layer: MemoryLayerChoice; note: string } | undefined {
  // Research's binding pins the live shared layer, so its writes name it as any shared write does.
  const pinned = ctx.memoryBinding?.layer
  if (pinned && !scope.root) return { layer: pinned, note: MEMORY_LAYER_NOTES[pinned] }
  if (ctx.memoryBinding || scope.root || !keepsLayers(ctx, deps)) return undefined
  const layer = layerOfScope(scope)
  return { layer, note: MEMORY_LAYER_NOTES[layer] }
}

function layerOfScope(scope: MemoryScope): MemoryLayerChoice {
  return scope.personKey ? 'person' : scope.channelKey && !scope.sharedPlace ? 'here' : 'shared'
}

/** The layer a write lands in for the checks that depend on it; a bound session's is its binding's `layer`, else its scope's unless it is a staged store. */
export function writeLayerOf(
  ctx: SessionContext,
  deps: MemoryOpsDeps,
  scope: MemoryScope
): MemoryLayerChoice | undefined {
  if (ctx.memoryBinding?.layer) return ctx.memoryBinding.layer
  if (scope.root || !keepsLayers(ctx, deps)) return undefined
  return layerOfScope(scope)
}

/** What a write's final text must pass before it is stored: the organization files' shapes in the shared layer (assistant-mode.md §5.15). */
export function memoryWriteCheck(
  ctx: SessionContext,
  deps: MemoryOpsDeps,
  scope: MemoryScope
): MemoryTextCheck | undefined {
  return writeLayerOf(ctx, deps, scope) === 'shared' ? organizationFileRefusal : undefined
}

function refuseByCheck(check: MemoryTextCheck | undefined, path: string, text: string): void {
  const refusal = check?.(path, text)
  if (refusal !== undefined) throw new Error(refusal)
}

/** Only the file memory keeps layers; an external memory's records, or an answer it cannot get, name none. */
function keepsLayers(ctx: SessionContext, deps: MemoryOpsDeps): boolean {
  try {
    return (deps.memory.adminSurfaceForAgent?.(ctx.agentId) ?? deps.memory.adminSurface())?.shape === 'files'
  } catch {
    return false
  }
}

/** A raw `layer` argument, checked; the dispatch boundary validated it already, so this only narrows the type. */
export function layerArgument(args: Record<string, unknown>): MemoryLayerChoice | undefined {
  return layerArg.parse(args.layer)
}

/** Provenance for a write made through the shared tool surface. The ordinary
 *  conversational case is `tool`; a distillation- or dream-bound session keeps its own
 *  source so the write ledger — and dream adoption's distill-only rebase — stay honest. */
/** Topics a bound session has SUCCESSFULLY written — the provenance record a dream checks its staged store against. */
const boundTopics = new WeakMap<SessionContext, Set<string>>()

/** Every topic this bound session wrote through the tool. A staged file that is NOT
 *  here did not come from the memory write path — see the dream's staging check. */
export function boundWrittenTopics(ctx: SessionContext): string[] {
  return [...(boundTopics.get(ctx) ?? [])]
}

/** Apply the binding's topic-name rule before a write reaches the store; the store still applies path containment and the byte cap underneath. */
function enforceBindingPolicy(ctx: SessionContext, path: string): void {
  const binding = ctx.memoryBinding
  if (!binding) return
  const name = topicOf(path)
  if (binding.topicPattern && !binding.topicPattern.test(name)) {
    throw new Error(`invalid memory path: "${name}" must match ${String(binding.topicPattern)}`)
  }
}

/** Record the topic only once the write is DURABLE. A refused write — a subdirectory
 *  path, an oversized body, a bad mode pair — must not vouch for that name, or a dream
 *  could name a topic here and then smuggle its content in some other way. */
function recordBoundTopic(ctx: SessionContext, path: string): void {
  if (!ctx.memoryBinding) return
  const seen = boundTopics.get(ctx) ?? new Set<string>()
  seen.add(topicOf(path))
  boundTopics.set(ctx, seen)
}

function topicOf(path: string): string {
  return path.replace(/^.*\//, '')
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
  const parsed = parseArgs(READ_MEMORY_ARGS, args)
  const scope = await memoryScopeFor(ctx, deps, { mode: 'read', ...(parsed.layer ? { layer: parsed.layer } : {}) })
  try {
    const path = parsed.path ?? 'MEMORY.md'
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
  const parsed = parseArgs(WRITE_MEMORY_ARGS, args)
  const scope = await memoryScopeFor(ctx, deps, { mode: 'write', ...(parsed.layer ? { layer: parsed.layer } : {}) })
  try {
    // Exactly one mode: full write (`content`) or an edit, which needs both `oldString` and `newString`.
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
      refuseByCheck(memoryWriteCheck(ctx, deps, scope), path, updated)
      const edited = await deps.memory.write(scope, path, updated, undefined, writeSource(ctx))
      recordBoundTopic(ctx, path)
      return { ...edited, ...writtenLayer(ctx, deps, scope) }
    }
    const full = parseArgs(requiredStringAllowEmpty('content'), content)
    refuseByCheck(memoryWriteCheck(ctx, deps, scope), path, full)
    const written = await deps.memory.write(scope, path, full, undefined, writeSource(ctx))
    recordBoundTopic(ctx, path)
    return { ...written, ...writtenLayer(ctx, deps, scope) }
  } catch (err) {
    toToolError(err)
  }
}

/** The record-memory surface for this call. External-memory tools are daemon-local but
 *  operate on canonical records instead of pretending the plugin has files. The current
 *  provider is re-resolved on EVERY call so a stale session tool cannot cross a provider or
 *  capability change. The trusted agent scope is always ctx.agentId. */
async function recordSurface(ctx: SessionContext, deps: MemoryOpsDeps, mode: 'read' | 'write') {
  const surface = deps.memory.adminSurfaceForAgent?.(ctx.agentId) ?? deps.memory.adminSurface()
  if (!surface || surface.shape !== 'records') throw new Error('record memory is not available for this agent')
  const scope = await memoryScopeFor(ctx, deps, { mode })
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
  const { surface, scope, requireCapability } = await recordSurface(ctx, deps, 'read')
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
  const { surface, scope, requireCapability } = await recordSurface(ctx, deps, 'write')
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
  const { surface, scope, requireCapability } = await recordSurface(ctx, deps, 'read')
  requireCapability('get')
  return { record: await surface.get(scope, parseArgs(GET_MEMORY_ARGS, args).id) }
}

export async function updateMemory(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: MemoryOpsDeps
): Promise<unknown> {
  const { surface, scope, requireCapability } = await recordSurface(ctx, deps, 'write')
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
  const { surface, scope, requireCapability } = await recordSurface(ctx, deps, 'write')
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
