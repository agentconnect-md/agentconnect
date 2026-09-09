import { mutateManagedMemoryEntry, type ManagedEntryMutation } from './writer.js'
import type { MemoryWriteSource } from '../store.js'
import { randomUUID } from 'node:crypto'
import type {
  MemoryContextResult,
  MemoryEntryCapabilities,
  MemoryEntryCreateRequest,
  MemoryEntryUpdateRequest
} from '@agentconnect.md/protocol'
import {
  listMemory,
  MemoryConflictError,
  MAX_MEMORY_FILE_BYTES,
  MEMORY_DIRNAME,
  MEMORY_INDEX,
  memoryTopicName,
  withMemoryDirLock,
  type MemoryFs
} from '../store.js'
import { parseMemoryFrontmatter } from '../frontmatter.js'
import {
  MemoryEntriesError,
  type EntryCoordinate,
  type EntryDocument,
  type EntryPage,
  type EntrySummary,
  type MemoryEntriesView
} from './contract.js'
import { memoryDigest, memoryUtf8Prefix } from './service.js'

const MAX_SNAPSHOT_ITEMS = 2048
const MAX_SNAPSHOT_READ_BYTES = 16 * 1024 * 1024

// Roots are resolved by core, most specific first; a draft supplies only its own root.
export class ManagedMemoryEntries implements MemoryEntriesView {
  readonly capabilities: MemoryEntryCapabilities = {
    version: 1,
    operations: ['list', 'get'],
    supportedScopes: ['agent', 'channel'],
    writeConsistency: 'last-write-wins',
    exactEdit: false,
    exactCreate: false,
    enumeration: 'live',
    graph: false,
    limits: { maxItemBytes: MAX_MEMORY_FILE_BYTES, maxPageItems: 100 }
  }
  readonly identity: string

  constructor(
    private readonly roots: readonly MemoryFs[],
    bindingGeneration: string,
    private readonly writeContext?: { source: MemoryWriteSource; sourceTurnId?: string }
  ) {
    if (roots.length < 1 || roots.length > 2) throw new Error('managed memory requires one root or an overlay')
    this.identity = memoryDigest(['managed', bindingGeneration, roots.map((root) => root.key)])
    if (writeContext && roots[0]!.atomicTransaction && roots[0]!.stageTransactionFile && roots[0]!.captureStatus) {
      this.capabilities = {
        ...this.capabilities,
        operations: ['list', 'get', 'create', 'update', 'delete'],
        writeConsistency: 'conditional',
        exactCreate: true,
        exactEdit: true
      }
    }
  }

  async list(): Promise<EntryPage> {
    return this.lock(async () => {
      const before = await this.inventory()
      if (
        before.length > MAX_SNAPSHOT_ITEMS ||
        before.reduce((sum, row) => sum + row.size, 0) > MAX_SNAPSHOT_READ_BYTES
      )
        throw new MemoryEntriesError('TOO_LARGE', 'managed catalog exceeds the snapshot scan budget')
      const entries: EntrySummary[] = []
      for (const row of before) {
        const document = await this.read({ partition: String(row.layer), id: row.name })
        if (!document) throw new MemoryEntriesError('CONFLICT', 'managed catalog changed while listing; retry')
        entries.push(document.summary)
      }
      const revision = memoryDigest(before)
      if (memoryDigest(await this.inventory()) !== revision)
        throw new MemoryEntriesError('CONFLICT', 'managed catalog changed while listing; retry')
      return { entries, catalogRevision: revision, order: 'topic' }
    })
  }

  async get(coordinate: EntryCoordinate): Promise<EntryDocument | null> {
    return this.lock(() => this.read(coordinate))
  }

  async context(request: { maxBytes: number }): Promise<MemoryContextResult> {
    return this.lock(async () => {
      const inventory = await this.inventory()
      const indexes = await Promise.all(this.roots.map((root) => root.readFile(`${MEMORY_DIRNAME}/${MEMORY_INDEX}`)))
      const text = [...indexes]
        .reverse()
        .map((index) => index?.content ?? '')
        .filter(Boolean)
        .join('\n\n')
      const overview = memoryUtf8Prefix(text, request.maxBytes)
      const stale = inventory.some((row) => !indexes[row.layer] || row.mtime > indexes[row.layer]!.mtime)
      return {
        catalogRevision: memoryDigest([this.identity, inventory, indexes.map((index) => index?.content ?? null)]),
        freshness: stale ? 'cached' : 'current',
        coverage: inventory.length === 0 && text === '' ? 'complete' : 'partial',
        overview
      }
    })
  }

  private async read(coordinate: EntryCoordinate): Promise<EntryDocument | null> {
    const layer = Number(coordinate.partition)
    if (!Number.isInteger(layer) || String(layer) !== coordinate.partition || layer < 0 || layer >= this.roots.length)
      throw new MemoryEntriesError('STALE_BINDING', 'memory partition is outside this view')
    let name: string
    try {
      name = memoryTopicName(coordinate.id)
    } catch {
      throw new MemoryEntriesError('INVALID_ARGUMENT', 'invalid memory topic')
    }
    if (name !== coordinate.id || name === MEMORY_INDEX)
      throw new MemoryEntriesError('INVALID_ARGUMENT', 'the generated overview is not a memory entry')
    if (layer > 0 && (await this.roots[0]!.readFile(`${MEMORY_DIRNAME}/${name}`))) return null
    const file = await this.roots[layer]!.readFile(`${MEMORY_DIRNAME}/${name}`)
    if (!file) return null
    if (file.size > MAX_MEMORY_FILE_BYTES)
      throw new MemoryEntriesError('TOO_LARGE', 'memory entry exceeds its item budget')
    const { header } = parseMemoryFrontmatter(file.content)
    return {
      text: file.content,
      summary: {
        coordinate,
        label: header.name ?? name.replace(/\.md$/, ''),
        ...(header.description ? { description: header.description } : {}),
        format: 'markdown',
        byteSize: Buffer.byteLength(file.content),
        updatedAt: file.mtime,
        revision: memoryDigest(file.content),
        origin: layer === 0 ? 'active' : 'inherited',
        editable: layer === 0 && this.capabilities.operations.includes('update')
      }
    }
  }

  async create(request: MemoryEntryCreateRequest) {
    if (request.metadata !== undefined)
      throw new MemoryEntriesError('UNSUPPORTED', 'managed metadata belongs in Markdown frontmatter')
    const name = request.label ?? randomUUID()
    const topic = name.endsWith('.md') ? name : `${name}.md`
    return this.mutate(topic, { operation: 'create', text: request.text })
  }

  async update(
    coordinate: EntryCoordinate,
    request:
      | Omit<Extract<MemoryEntryUpdateRequest, { text: string }>, 'ref'>
      | Omit<Extract<MemoryEntryUpdateRequest, { edit: unknown }>, 'ref'>
  ) {
    this.writableCoordinate(coordinate)
    if (!request.revision) throw new MemoryEntriesError('INVALID_ARGUMENT', 'managed update requires a revision')
    if (request.metadata !== undefined)
      throw new MemoryEntriesError('UNSUPPORTED', 'managed metadata belongs in Markdown frontmatter')
    return this.mutate(
      coordinate.id,
      'text' in request
        ? { operation: 'update', revision: request.revision, text: request.text }
        : { operation: 'update', revision: request.revision, edit: request.edit }
    )
  }

  async delete(coordinate: EntryCoordinate, request: { revision?: string }) {
    this.writableCoordinate(coordinate)
    if (!request.revision) throw new MemoryEntriesError('INVALID_ARGUMENT', 'managed delete requires a revision')
    return this.mutate(coordinate.id, { operation: 'delete', revision: request.revision })
  }

  private writableCoordinate(coordinate: EntryCoordinate) {
    if (coordinate.partition !== '0')
      throw new MemoryEntriesError('FORBIDDEN', 'inherited entries cannot be changed from this view')
  }

  private async mutate(topic: string, mutation: ManagedEntryMutation) {
    if (!this.writeContext || !this.capabilities.operations.includes(mutation.operation))
      throw new MemoryEntriesError('UNSUPPORTED', 'memory entry mutations are unavailable')
    const result = await mutateManagedMemoryEntry(this.roots[0]!, topic, mutation, this.writeContext)
    const file = result.receipt.files.find((entry) => entry.path === topic)!
    const header = result.content === null ? undefined : parseMemoryFrontmatter(result.content).header
    return {
      operationId: result.receipt.operationId,
      catalogRevision: result.receipt.revision,
      ...(result.content === null
        ? {}
        : {
            entry: {
              coordinate: { partition: '0', id: topic },
              label: header?.name ?? topic.replace(/\.md$/, ''),
              ...(header?.description ? { description: header.description } : {}),
              format: 'markdown' as const,
              byteSize: Buffer.byteLength(result.content),
              updatedAt: file.mtime!,
              revision: result.revision,
              origin: 'active' as const,
              editable: true
            }
          })
    }
  }

  private async inventory() {
    const rows = new Map<string, { name: string; size: number; mtime: string; layer: number }>()
    for (let layer = this.roots.length - 1; layer >= 0; layer--) {
      for (const file of await listMemory(this.roots[layer]!))
        if (file.name !== MEMORY_INDEX) rows.set(file.name, { ...file, layer })
    }
    return [...rows.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  private lock<T>(operation: () => Promise<T>): Promise<T> {
    const roots = [...this.roots].sort((a, b) => (a.key < b.key ? -1 : 1))
    const acquire = (index: number): Promise<T> =>
      index === roots.length ? operation() : withMemoryDirLock(roots[index]!, () => acquire(index + 1))
    return acquire(0)
  }
}

// The marker travels with the logical tree; replacing the tree invalidates references to its old entries.
export async function managedMemoryEntries(
  roots: readonly MemoryFs[],
  bindingGeneration: string,
  writeContext?: { source: MemoryWriteSource; sourceTurnId?: string }
): Promise<ManagedMemoryEntries> {
  const lineages: string[] = []
  for (const root of roots) {
    lineages.push(
      await withMemoryDirLock(root, async () => {
        const path = `${MEMORY_DIRNAME}/.entry-lineage`
        let marker = await root.readFile(path)
        if (!marker) {
          try {
            await root.writeFile(path, randomUUID(), { ifAbsent: true, mode: 0o600 })
          } catch (error) {
            if (!(error instanceof MemoryConflictError)) throw error
          }
          marker = await root.readFile(path)
        }
        if (!marker || !/^[0-9a-f-]{36}$/.test(marker.content))
          throw new MemoryEntriesError('UNAVAILABLE', 'managed memory lineage is invalid')
        return marker.content
      })
    )
  }
  return new ManagedMemoryEntries(roots, memoryDigest([bindingGeneration, lineages]), writeContext)
}
