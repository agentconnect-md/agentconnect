import { randomUUID } from 'node:crypto'
import { MemoryTransactionPath, type MemoryTransactionReceipt } from '@agentconnect.md/protocol'
import { atomicMutateMemoryFileHoldingLock, MemoryAmbiguousWriteError } from '../atomic-write.js'
import {
  MemoryConflictError,
  MemoryHomeUnavailableError,
  MemoryTooLargeError,
  MemoryPathError,
  type MemoryFs,
  type MemoryFsFile
} from '../fs.js'
import {
  listMemory,
  MAX_MEMORY_FILE_BYTES,
  MEMORY_DIRNAME,
  MEMORY_INDEX,
  memoryHistoryRecord,
  recordExternalMemoryMutation,
  regenerateMemoryIndexHoldingLock,
  withMemoryDirLock,
  type MemoryHistorySink,
  type MemoryWriteSource
} from '../store.js'
import { normalizeMemoryHeader, stampMemoryHeader } from '../frontmatter.js'
import { MemoryEntriesError } from './contract.js'
import { memoryDigest } from './service.js'

// A revision is required by a conditional home and optional on a last-write-wins one, where it is checked when given.
export type ManagedEntryMutation =
  | { operation: 'create'; text: string }
  | { operation: 'update'; revision?: string; text: string; edit?: never }
  | { operation: 'update'; revision?: string; text?: never; edit: { oldText: string; newText: string } }
  | { operation: 'delete'; revision?: string }

// The same publication authority as compatibility writes; caller resolves scope and assigns provenance before entry.
export async function mutateManagedMemoryEntry(
  fs: MemoryFs,
  topic: string,
  mutation: ManagedEntryMutation,
  context: { source: MemoryWriteSource; sourceTurnId?: string },
  now: () => Date = () => new Date()
) {
  if (!MemoryTransactionPath.safeParse(topic).success || topic === MEMORY_INDEX)
    throw new MemoryEntriesError('INVALID_ARGUMENT', 'expected a topic Markdown filename, not the generated index')
  if (!fs.atomicTransaction || !fs.stageTransactionFile || !fs.captureStatus)
    throw new MemoryEntriesError('UNSUPPORTED', 'this memory home does not support conditional entry mutations')
  return withMemoryDirLock(fs, async () => {
    try {
      const result = await atomicMutateMemoryFileHoldingLock(
        fs,
        topic,
        (current) => prepareEntryMutation(current, mutation, topic, now),
        context.source,
        context.sourceTurnId
      )
      recordExternalMemoryMutation(fs, context.source)
      return { ...result, revision: result.content === null ? undefined : memoryDigest(result.content) }
    } catch (error) {
      if (error instanceof MemoryAmbiguousWriteError) {
        recordExternalMemoryMutation(fs, 'console')
        throw new MemoryEntriesError('AMBIGUOUS_WRITE', error.message)
      }
      if (error instanceof MemoryEntriesError) throw error
      if (error instanceof MemoryConflictError) throw new MemoryEntriesError('CONFLICT', error.message)
      if (error instanceof MemoryTooLargeError) throw new MemoryEntriesError('TOO_LARGE', error.message)
      if (error instanceof MemoryPathError) throw new MemoryEntriesError('INVALID_ARGUMENT', error.message)
      if (error instanceof MemoryHomeUnavailableError) throw new MemoryEntriesError('UNAVAILABLE', error.message)
      throw new MemoryEntriesError('UNAVAILABLE', 'memory mutation could not be prepared')
    }
  })
}

// The precondition and the stored text, the same for every home: null is an explicit delete.
function prepareEntryMutation(
  current: MemoryFsFile | null,
  mutation: ManagedEntryMutation,
  topic: string,
  now: () => Date
): string | null {
  if (mutation.operation === 'create') {
    if (current) throw new MemoryEntriesError('CONFLICT', 'memory entry already exists', memoryDigest(current.content))
  } else {
    if (!current) throw new MemoryEntriesError('NOT_FOUND', 'memory entry does not exist')
    if (mutation.revision !== undefined && mutation.revision !== memoryDigest(current.content))
      throw new MemoryEntriesError(
        'CONFLICT',
        'memory entry revision changed; read it again before editing',
        memoryDigest(current.content)
      )
  }
  if (mutation.operation === 'delete') return null
  let text = mutation.text
  if (mutation.operation === 'update' && mutation.edit) {
    const { oldText, newText } = mutation.edit
    if (!oldText || current!.content.split(oldText).length !== 2)
      throw new MemoryEntriesError('CONFLICT', 'exact edit must match one non-empty occurrence')
    text = current!.content.replace(oldText, () => newText)
  }
  if (typeof text !== 'string') throw new MemoryEntriesError('INVALID_ARGUMENT', 'replacement text is required')
  const content = stampMemoryHeader(topic, normalizeMemoryHeader(text), now().toISOString())
  if (Buffer.byteLength(content) > MAX_MEMORY_FILE_BYTES)
    throw new MemoryTooLargeError('memory entry exceeds its byte limit')
  return content
}

// A home without the transaction primitive: the compatibility writer's own guarantees, projected as an entry mutation
// and advertised as last-write-wins. A supplied revision is checked under the per-directory lock every daemon-side
// writer takes, and the replace or unlink carries the filesystem's absent/mtime guard, so a stale daemon-side write is
// refused and an out-of-band one is caught on a best-effort basis, never with the home authority's atomic check. The
// index and the change log follow, not in the same commit; the receipt is minted here and kept nowhere, so a lost
// answer is never replayed. Nothing here stands in for `atomicTransaction`; a home that has it takes the other path.
export async function mutateManagedMemoryEntryOnFilesystem(
  fs: MemoryFs,
  topic: string,
  mutation: ManagedEntryMutation,
  context: { source: MemoryWriteSource },
  history: MemoryHistorySink,
  now: () => Date = () => new Date()
): Promise<{ content: string | null; receipt: MemoryTransactionReceipt; revision: string | undefined }> {
  if (!MemoryTransactionPath.safeParse(topic).success || topic === MEMORY_INDEX)
    throw new MemoryEntriesError('INVALID_ARGUMENT', 'expected a topic Markdown filename, not the generated index')
  const path = `${MEMORY_DIRNAME}/${topic}`
  return withMemoryDirLock(fs, async () => {
    // Once the port has been asked to publish, a failure no longer proves the tree unchanged: the port may have applied
    // the change and lost its reply, or the file changed and what follows it (log, index, receipt) failed. Those are
    // reported as unconfirmed and never replayed; a refusal the port proves before publishing keeps its own code.
    let dispatched = false
    try {
      const current = await fs.readFile(path)
      const content = prepareEntryMutation(current, mutation, topic, now)
      if (content === null && !fs.rmIfMatch)
        throw new MemoryEntriesError('UNSUPPORTED', 'this memory home cannot delete an entry conditionally')
      let file: MemoryTransactionReceipt['files'][number]
      dispatched = true
      if (content === null) {
        await fs.rmIfMatch!(path, current!.mtime)
        file = { path: topic, revision: null, mtime: null }
      } else {
        const stat = await fs.writeFile(path, content, current ? { ifMatchMtime: current.mtime } : { ifAbsent: true })
        file = { path: topic, revision: memoryDigest(content), mtime: stat.mtime }
      }
      recordExternalMemoryMutation(fs, context.source)
      const committedAt = now().toISOString()
      try {
        await history.append([
          memoryHistoryRecord(topic, current?.content, content ?? undefined, file.mtime ?? committedAt, context.source)
        ])
      } catch {
        // Provenance is best-effort, exactly as for a compatibility write.
      }
      await regenerateMemoryIndexHoldingLock(fs, context.source, { history })
      const inventory = await listMemory(fs)
      const revision = memoryDigest(inventory.map((entry) => [entry.name, entry.size, entry.mtime]))
      return {
        content,
        receipt: { operationId: randomUUID(), committedAt, revision, files: [file] },
        revision: content === null ? undefined : file.revision!
      }
    } catch (error) {
      if (error instanceof MemoryEntriesError) throw error
      // A port refuses these before it publishes anything, whichever side of the dispatch they surface on.
      if (error instanceof MemoryConflictError) throw new MemoryEntriesError('CONFLICT', error.message)
      if (error instanceof MemoryTooLargeError) throw new MemoryEntriesError('TOO_LARGE', error.message)
      if (error instanceof MemoryPathError) throw new MemoryEntriesError('INVALID_ARGUMENT', error.message)
      if (!dispatched) {
        if (error instanceof MemoryHomeUnavailableError) throw new MemoryEntriesError('UNAVAILABLE', error.message)
        throw new MemoryEntriesError('UNAVAILABLE', 'memory mutation could not be prepared')
      }
      recordExternalMemoryMutation(fs, 'console')
      throw new MemoryEntriesError(
        'AMBIGUOUS_WRITE',
        'memory mutation outcome is unconfirmed; read current state before retrying'
      )
    }
  })
}
