import { createHash, randomUUID } from 'node:crypto'
import type { MemoryTransactionResult } from '@agentconnect.md/protocol'
import {
  MemoryConflictError,
  MemoryHomeUnavailableError,
  MemoryPathError,
  MemoryTooLargeError,
  type MemoryFs,
  type MemoryFsTransactionRequest
} from './fs.js'
import { deriveMemoryIndex, listMemory, MEMORY_DIRNAME, MEMORY_INDEX, type MemoryWriteSource } from './store.js'
import { memoryNameForTopic, parseMemoryFrontmatter } from './frontmatter.js'

const digest = (text: string) => createHash('sha256').update(text).digest('hex')

export class MemoryAmbiguousWriteError extends Error {
  constructor(readonly operationId: string) {
    super(`Memory write ${operationId} could not be confirmed; its outcome is unknown`)
    this.name = 'MemoryAmbiguousWriteError'
  }
}

function rejected(result: Extract<MemoryTransactionResult, { operation: 'error' }>): never {
  if (result.code === 'CONFLICT') throw new MemoryConflictError(result.message)
  if (result.code === 'TOO_LARGE') throw new MemoryTooLargeError(result.message)
  if (result.code === 'INVALID_ARGUMENT') throw new MemoryPathError(result.message)
  throw new MemoryHomeUnavailableError(result.code === 'FORBIDDEN' ? 'scope-denied' : 'connection', result.message)
}

// Caller holds the memory-dir lock and has normalized/stamped the topic; CP serializes against other daemons too.
export async function atomicWriteMemoryFileHoldingLock(
  fs: MemoryFs,
  topic: string,
  content: string,
  ifMatchMtime: string | undefined,
  source: MemoryWriteSource,
  sourceTurnId?: string
): Promise<{ size: number; mtime: string }> {
  const transact = fs.atomicTransaction
  const stage = fs.stageTransactionFile
  if (!transact || !stage) throw new MemoryHomeUnavailableError('feature', 'atomic memory publication is unavailable')
  const snapshot = await transact({ operation: 'snapshot', root: MEMORY_DIRNAME })
  if (snapshot.operation === 'error') rejected(snapshot)
  if (snapshot.operation !== 'snapshot')
    throw new MemoryHomeUnavailableError('connection', 'unexpected memory snapshot reply')
  const current = await fs.readFile(`${MEMORY_DIRNAME}/${topic}`)
  if (ifMatchMtime && current?.mtime !== ifMatchMtime) throw new MemoryConflictError('memory file changed')
  const replacements = [{ path: topic, content, previous: current?.content ?? null }]
  if (topic !== MEMORY_INDEX) {
    const entries = []
    const inventory = await listMemory(fs)
    if (inventory.length > 2048 || inventory.reduce((sum, file) => sum + file.size, 0) > 16 * 1024 * 1024)
      throw new MemoryTooLargeError('memory tree exceeds the transaction preparation budget')
    for (const file of inventory) {
      if (file.name === MEMORY_INDEX || file.name === topic) continue
      const value = await fs.readFile(`${MEMORY_DIRNAME}/${file.name}`)
      if (!value) throw new MemoryConflictError('memory tree changed while preparing its index')
      const { header } = parseMemoryFrontmatter(value.content)
      entries.push({
        topic: file.name,
        name: header.name || memoryNameForTopic(file.name),
        description: header.description ?? ''
      })
    }
    const { header } = parseMemoryFrontmatter(content)
    entries.push({ topic, name: header.name || memoryNameForTopic(topic), description: header.description ?? '' })
    const index = await fs.readFile(`${MEMORY_DIRNAME}/${MEMORY_INDEX}`)
    const next = deriveMemoryIndex(entries, index?.content)
    if (next !== undefined) replacements.push({ path: MEMORY_INDEX, content: next, previous: index?.content ?? null })
  }
  const changes: Extract<MemoryFsTransactionRequest, { operation: 'commit' }>['changes'] = []
  let dispatched = false
  try {
    for (const replacement of replacements) {
      const staged = await stage(MEMORY_DIRNAME, replacement.content)
      changes.push({
        action: 'put',
        path: replacement.path,
        expectedRevision: replacement.previous === null ? null : digest(replacement.previous),
        temp: staged.temp,
        stagedRevision: staged.revision
      })
    }
    const request: MemoryFsTransactionRequest = {
      operation: 'commit',
      root: MEMORY_DIRNAME,
      operationId: randomUUID(),
      expectedRevision: snapshot.revision,
      source,
      ...(sourceTurnId ? { sourceTurnId } : {}),
      changes
    }
    dispatched = true
    let result: MemoryTransactionResult
    try {
      result = await transact(request)
    } catch {
      // An identical durable operation is safe to replay once; never rebuild it against a fresh snapshot.
      try {
        result = await transact(request)
        if (result.operation !== 'commit') throw new Error('unconfirmed replay')
      } catch {
        throw new MemoryAmbiguousWriteError(request.operationId)
      }
    }
    if (result.operation === 'error') {
      if (result.code === 'AMBIGUOUS_WRITE') throw new MemoryAmbiguousWriteError(request.operationId)
      dispatched = false
      rejected(result)
    }
    if (result.operation !== 'commit') throw new MemoryAmbiguousWriteError(request.operationId)
    if (
      result.receipt.operationId !== request.operationId ||
      result.receipt.files.length !== changes.length ||
      !changes.every((change) =>
        result.receipt.files.some(
          (file) =>
            file.path === change.path &&
            change.action === 'put' &&
            file.revision === change.stagedRevision &&
            file.mtime !== null
        )
      )
    )
      throw new MemoryAmbiguousWriteError(request.operationId)
    const committed = result.receipt.files.find((file) => file.path === topic)
    if (!committed?.mtime || committed.revision !== digest(content))
      throw new MemoryAmbiguousWriteError(request.operationId)
    return { size: Buffer.byteLength(content), mtime: committed.mtime }
  } finally {
    // Never remove staging after an ambiguous commit; the home owns expiration of abandoned staging.
    if (!dispatched)
      await Promise.all(
        changes.map((change) =>
          change.action === 'put' ? fs.rm(`${MEMORY_DIRNAME}/${change.temp}`).catch(() => {}) : undefined
        )
      )
  }
}
