import { MemoryTransactionPath } from '@agentconnect.md/protocol'
import { atomicMutateMemoryFileHoldingLock, MemoryAmbiguousWriteError } from '../atomic-write.js'
import {
  MemoryConflictError,
  MemoryHomeUnavailableError,
  MemoryTooLargeError,
  MemoryPathError,
  type MemoryFs
} from '../fs.js'
import {
  MAX_MEMORY_FILE_BYTES,
  MEMORY_INDEX,
  recordExternalMemoryMutation,
  withMemoryDirLock,
  type MemoryWriteSource
} from '../store.js'
import { normalizeMemoryHeader, stampMemoryHeader } from '../frontmatter.js'
import { MemoryEntriesError } from './contract.js'
import { memoryDigest } from './service.js'

export type ManagedEntryMutation =
  | { operation: 'create'; text: string }
  | { operation: 'update'; revision: string; text: string; edit?: never }
  | { operation: 'update'; revision: string; text?: never; edit: { oldText: string; newText: string } }
  | { operation: 'delete'; revision: string }

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
        (current) => {
          if (mutation.operation === 'create') {
            if (current)
              throw new MemoryEntriesError('CONFLICT', 'memory entry already exists', memoryDigest(current.content))
          } else {
            if (!current) throw new MemoryEntriesError('NOT_FOUND', 'memory entry does not exist')
            if (mutation.revision !== memoryDigest(current.content))
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
        },
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
