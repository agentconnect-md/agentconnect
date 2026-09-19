import { mutateManagedMemoryEntry, mutateManagedMemoryEntryOnFilesystem, type ManagedEntryMutation } from './writer.js'
import { sidecarMemoryHistory } from '../home.js'
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
  listMemoryHistory,
  MemoryConflictError,
  MemoryHistoryNotLocalError,
  MAX_MEMORY_FILE_BYTES,
  MEMORY_DIRNAME,
  MEMORY_INDEX,
  memoryNeighbors,
  memoryTopicName,
  withMemoryDirLock,
  type MemoryFs,
  type MemoryHistorySink,
  type MemoryNeighbor
} from '../store.js'
import { MemoryHomeUnavailableError, MemoryPathError } from '../fs.js'
import { parseMemoryFrontmatter } from '../frontmatter.js'
import {
  MemoryEntriesError,
  type EntryCoordinate,
  type EntryDocument,
  type EntryHistoryPage,
  type EntryLink,
  type EntryPage,
  type EntrySearchPage,
  type EntrySummary,
  type MemoryEntriesView
} from './contract.js'
import { memoryDigest, memoryUtf8Prefix } from './service.js'

const MAX_SNAPSHOT_ITEMS = 2048
const MAX_SNAPSHOT_READ_BYTES = 16 * 1024 * 1024
const SNIPPET_CHARS = 240

// Deterministic substring matching of every whitespace-separated term over label, description and body.
function lexicalMatch(terms: string[], document: EntryDocument): { score: number; snippet: string } | undefined {
  const label = document.summary.label.toLowerCase()
  const description = (document.summary.description ?? '').toLowerCase()
  const body = parseMemoryFrontmatter(document.text).body
  const haystack = body.toLowerCase()
  let score = 0
  let first = -1
  for (const term of terms) {
    const inLabel = label.includes(term)
    const inDescription = description.includes(term)
    const at = haystack.indexOf(term)
    if (!inLabel && !inDescription && at < 0) return undefined
    score +=
      (inLabel ? 3 : 0) +
      (inDescription ? 2 : 0) +
      (at >= 0 ? 1 + Math.min(haystack.split(term).length - 1, 9) / 10 : 0)
    if (at >= 0 && (first < 0 || at < first)) first = at
  }
  // Case folding can change string length; only a same-length fold can index the original text.
  return { score, snippet: snippetAround(body, haystack.length === body.length ? first : -1) }
}

function snippetAround(body: string, at: number): string {
  const start = at < 0 ? 0 : Math.max(0, at - Math.floor(SNIPPET_CHARS / 3))
  const window = body.slice(start, start + SNIPPET_CHARS)
  const text = window
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\uD800-\uDBFF]$/, '')
  return `${start > 0 ? '…' : ''}${text}${start + SNIPPET_CHARS < body.length ? '…' : ''}`
}

// Roots are resolved by core, most specific first; a draft supplies only its own root.
export class ManagedMemoryEntries implements MemoryEntriesView {
  readonly capabilities: MemoryEntryCapabilities = {
    version: 1,
    operations: ['list', 'get', 'search'],
    searchKind: 'lexical',
    supportedScopes: ['agent', 'channel'],
    writeConsistency: 'last-write-wins',
    exactEdit: false,
    exactCreate: false,
    enumeration: 'live',
    graph: true,
    limits: { maxItemBytes: MAX_MEMORY_FILE_BYTES, maxPageItems: 100 }
  }
  readonly identity: string

  constructor(
    private readonly roots: readonly MemoryFs[],
    bindingGeneration: string,
    private readonly writeContext?: { source: MemoryWriteSource; sourceTurnId?: string },
    private readonly historyFor?: (root: MemoryFs) => MemoryHistorySink
  ) {
    if (roots.length < 1 || roots.length > 2) throw new Error('managed memory requires one root or an overlay')
    this.identity = memoryDigest(['managed', bindingGeneration, roots.map((root) => root.key)])
    // Every writable home serves the mutations, but only a transactional home may call them conditional: any other
    // gets the compatibility writer's last-write-wins (writer.ts), with delete only where the port verifies before it
    // unlinks. Exact create (an exclusive publish) and exact edit (one literal match) hold on both.
    if (writeContext) {
      const root = roots[0]!
      const transactional = !!(root.atomicTransaction && root.stageTransactionFile && root.captureStatus)
      this.capabilities = {
        ...this.capabilities,
        operations: [
          'list',
          'get',
          'search',
          'create',
          'update',
          ...(transactional || root.rmIfMatch ? (['delete'] as const) : [])
        ],
        writeConsistency: transactional ? 'conditional' : 'last-write-wins',
        exactCreate: true,
        exactEdit: true
      }
    }
    // History is a console read over the home's change log; a home that pages it nowhere advertises none.
    if (historyFor?.(roots[0]!).list)
      this.capabilities = { ...this.capabilities, operations: [...this.capabilities.operations, 'history'] }
  }

  async history(coordinate: EntryCoordinate, request: { cursor?: string; limit: number }): Promise<EntryHistoryPage> {
    const { layer, name } = this.locate(coordinate)
    const sink = this.historyFor?.(this.roots[layer]!)
    if (!sink?.list || !this.capabilities.operations.includes('history'))
      throw new MemoryEntriesError('UNSUPPORTED', 'this memory home does not page its change log here')
    try {
      const page = await listMemoryHistory(sink, name, request.cursor, request.limit)
      return {
        order: 'newest-first',
        events: page.events.map((event) => ({
          ...(event.id ? { id: event.id } : {}),
          kind: event.event === 'add' ? ('create' as const) : event.event,
          at: event.at,
          source: event.source,
          ...(event.before !== undefined ? { before: event.before } : {}),
          after: event.after,
          ...(event.truncated ? { truncated: true } : {})
        })),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
      }
    } catch (error) {
      if (error instanceof MemoryEntriesError) throw error
      if (error instanceof MemoryHistoryNotLocalError)
        throw new MemoryEntriesError('UNSUPPORTED', 'this memory home does not page its change log here')
      if (error instanceof MemoryPathError) throw new MemoryEntriesError('INVALID_ARGUMENT', error.message)
      if (error instanceof MemoryHomeUnavailableError) throw new MemoryEntriesError('UNAVAILABLE', error.message)
      throw new MemoryEntriesError('UNAVAILABLE', 'memory history is temporarily unavailable')
    }
  }

  // The layer and validated topic a coordinate names inside this view; the generated overview is never an entry.
  private locate(coordinate: EntryCoordinate): { layer: number; name: string } {
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
    return { layer, name }
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
    return this.lock(async () => {
      const document = await this.read(coordinate)
      if (!document) return null
      const graph = await this.graph(coordinate.id)
      return graph ? { ...document, ...graph } : document
    })
  }

  // One hop of the [[name]] graph across the overlay; omitted, never truncated, beyond the scan budget.
  private async graph(topic: string): Promise<Pick<EntryDocument, 'links' | 'backlinks'> | undefined> {
    const inventory = await this.inventory()
    if (
      inventory.length > MAX_SNAPSHOT_ITEMS ||
      inventory.reduce((sum, row) => sum + row.size, 0) > MAX_SNAPSHOT_READ_BYTES
    )
      return undefined
    const layers = new Map(inventory.map((row) => [row.name, row.layer]))
    const neighbors = await memoryNeighbors([...this.roots], topic)
    const link = (neighbor: MemoryNeighbor): EntryLink => {
      const layer = layers.get(neighbor.topic)
      return {
        label: neighbor.name,
        exists: neighbor.exists,
        ...(neighbor.exists && layer !== undefined
          ? { coordinate: { partition: String(layer), id: neighbor.topic } }
          : {})
      }
    }
    return { links: neighbors.links.slice(0, 20).map(link), backlinks: neighbors.backlinks.slice(0, 20).map(link) }
  }

  // A bounded scan in topic order; exhausting the scan budget is reported, never hidden.
  async search(request: { query: string; limit: number }): Promise<EntrySearchPage> {
    const terms = [...new Set(request.query.toLowerCase().split(/\s+/).filter(Boolean))]
    if (terms.length === 0) return { hits: [], kind: 'lexical', coverage: 'complete' }
    return this.lock(async () => {
      const scored: Array<{ entry: EntrySummary; snippet: string; score: number }> = []
      let coverage: EntrySearchPage['coverage'] = 'complete'
      let scanned = 0
      let bytes = 0
      for (const row of await this.inventory()) {
        if (scanned >= MAX_SNAPSHOT_ITEMS || bytes + row.size > MAX_SNAPSHOT_READ_BYTES) {
          coverage = 'partial'
          break
        }
        scanned++
        bytes += row.size
        let document: EntryDocument | null
        try {
          document = await this.read({ partition: String(row.layer), id: row.name })
        } catch (error) {
          if (!(error instanceof MemoryEntriesError) || error.code !== 'TOO_LARGE') throw error
          coverage = 'partial'
          continue
        }
        if (!document) continue
        const match = lexicalMatch(terms, document)
        if (match) scored.push({ entry: document.summary, ...match })
      }
      scored.sort(
        (a, b) =>
          b.score - a.score ||
          (a.entry.coordinate.id < b.entry.coordinate.id ? -1 : a.entry.coordinate.id > b.entry.coordinate.id ? 1 : 0)
      )
      return {
        hits: scored.slice(0, request.limit).map(({ entry, snippet }) => ({ entry, snippet })),
        kind: 'lexical',
        coverage
      }
    })
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
    const { layer, name } = this.locate(coordinate)
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
    if (!request.revision && this.capabilities.writeConsistency === 'conditional')
      throw new MemoryEntriesError('INVALID_ARGUMENT', 'managed update requires a revision')
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
    if (!request.revision && this.capabilities.writeConsistency === 'conditional')
      throw new MemoryEntriesError('INVALID_ARGUMENT', 'managed delete requires a revision')
    return this.mutate(coordinate.id, { operation: 'delete', revision: request.revision })
  }

  private writableCoordinate(coordinate: EntryCoordinate) {
    if (coordinate.partition !== '0')
      throw new MemoryEntriesError('FORBIDDEN', 'inherited entries cannot be changed from this view')
  }

  private async mutate(topic: string, mutation: ManagedEntryMutation) {
    if (!this.writeContext || !this.capabilities.operations.includes(mutation.operation))
      throw new MemoryEntriesError('UNSUPPORTED', 'memory entry mutations are unavailable')
    const root = this.roots[0]!
    const result =
      root.atomicTransaction && root.stageTransactionFile && root.captureStatus
        ? await mutateManagedMemoryEntry(root, topic, mutation, this.writeContext)
        : await mutateManagedMemoryEntryOnFilesystem(
            root,
            topic,
            mutation,
            this.writeContext,
            this.historyFor?.(root) ?? sidecarMemoryHistory(root)
          )
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
  writeContext?: { source: MemoryWriteSource; sourceTurnId?: string },
  historyFor?: (root: MemoryFs) => MemoryHistorySink
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
  return new ManagedMemoryEntries(roots, memoryDigest([bindingGeneration, lineages]), writeContext, historyFor)
}
