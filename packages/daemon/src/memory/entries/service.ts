import { createHash } from 'node:crypto'
import {
  MEMORY_ENTRY_FRAME_BYTES,
  MemoryContextRequest,
  MemoryContextResult,
  MemoryEntryCapabilities,
  MemoryEntryContent,
  MemoryEntryGetRequest,
  MemoryEntryListRequest,
  MemoryEntryListResult,
  MemoryEntrySummary
} from '@agentconnect.md/protocol'
import {
  MemoryEntriesError,
  type EntryCoordinate,
  type EntrySummary,
  type MemoryContinuationStore,
  type MemoryEntriesView
} from './contract.js'
import { MemoryEntryTokens } from './tokens.js'

const CURSOR_TTL_MS = 30 * 60 * 1000
const MAX_CONTINUATION_BYTES = 2 * 1024 * 1024
const CURSOR_RESERVE = 256
interface ListContinuation {
  operation: 'list'
  order: 'topic' | 'backend'
  view: string
  limit: number
  pending: EntrySummary[]
  backendCursor?: string
  catalogRevision?: string
}
interface ContentContinuation {
  operation: 'get'
  view: string
  coordinate: EntryCoordinate
  digest: string
  offset: number
  maxBytes: number
}
type Continuation = ListContinuation | ContentContinuation

export function memoryDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
export function memoryJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}
export function memoryUtf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text)
  let end = Math.min(maxBytes, bytes.length)
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString('utf8')
}

function preview(text: string, length: number): string {
  return text.slice(0, length).replace(/[\uD800-\uDBFF]$/, '')
}
function boundedSummary(entry: EntrySummary): EntrySummary {
  return {
    ...entry,
    label: preview(entry.label, 512),
    ...(entry.description === undefined ? {} : { description: preview(entry.description, 1024) })
  }
}

// Both authenticated projections use this service; adapters never choose caller scope or response budgets.
export class MemoryEntries {
  constructor(
    private readonly resolve: () => Promise<MemoryEntriesView>,
    private readonly tokens: MemoryEntryTokens,
    private readonly continuations: MemoryContinuationStore,
    private readonly now: () => number = Date.now
  ) {}

  async describe(): Promise<MemoryEntryCapabilities> {
    return this.call(async () => MemoryEntryCapabilities.parse((await this.resolve()).capabilities))
  }

  async list(request: unknown = {}): Promise<MemoryEntryListResult> {
    const req = this.parse(MemoryEntryListRequest, request)
    return this.call(async () => {
      const view = await this.resolve()
      if (!view.capabilities.operations.includes('list') || !view.list)
        throw new MemoryEntriesError('UNSUPPORTED', 'memory enumeration is unavailable')
      const limit = Math.min(req.limit, view.capabilities.limits.maxPageItems)
      let state: ListContinuation = { operation: 'list', view: view.identity, limit, pending: [], order: 'backend' }
      if (req.cursor) {
        const decoded = await this.cursor(req.cursor, view.identity)
        if (decoded.operation !== 'list' || decoded.limit !== limit)
          throw new MemoryEntriesError('INVALID_ARGUMENT', 'cursor operation or page size changed')
        state = decoded
      }
      if (!req.cursor || (state.pending.length === 0 && state.backendCursor)) {
        const page = await view.list({ limit, ...(state.backendCursor ? { cursor: state.backendCursor } : {}) })
        if (page.nextCursor && (page.nextCursor === state.backendCursor || page.nextCursor.length > 2048))
          throw new MemoryEntriesError('UNAVAILABLE', 'provider returned an invalid continuation')
        state = {
          ...state,
          pending: page.entries.map(boundedSummary),
          order: page.order,
          backendCursor: page.nextCursor,
          catalogRevision: page.catalogRevision
        }
      }
      const result: MemoryEntryListResult = {
        entries: [],
        consistency: view.capabilities.enumeration === 'snapshot' ? 'snapshot' : 'live',
        order: state.order,
        ...(state.catalogRevision ? { catalogRevision: state.catalogRevision } : {})
      }
      let consumed = 0
      for (const entry of state.pending) {
        if (result.entries.length >= limit) break
        const summary = this.summary(view, entry)
        if (
          memoryJsonBytes({ ...result, entries: [...result.entries, summary] }) >
          MEMORY_ENTRY_FRAME_BYTES - CURSOR_RESERVE
        )
          break
        result.entries.push(summary)
        consumed++
      }
      if (consumed === 0 && state.pending.length)
        throw new MemoryEntriesError('TOO_LARGE', 'memory summary exceeds the response budget')
      state.pending = state.pending.slice(consumed)
      if (state.pending.length || state.backendCursor) result.nextCursor = await this.saveCursor(state)
      return MemoryEntryListResult.parse(result)
    })
  }

  async get(request: unknown): Promise<MemoryEntryContent | null> {
    const req = this.parse(MemoryEntryGetRequest, request)
    return this.call(async () => {
      const view = await this.resolve()
      if (!view.capabilities.operations.includes('get') || !view.get)
        throw new MemoryEntriesError('UNSUPPORTED', 'memory content is unavailable')
      const coordinate = this.tokens.coordinate(view.identity, req.ref)
      let prior: ContentContinuation | undefined
      if (req.cursor) {
        const decoded = await this.cursor(req.cursor, view.identity)
        if (
          decoded.operation !== 'get' ||
          decoded.maxBytes !== req.maxBytes ||
          memoryDigest(decoded.coordinate) !== memoryDigest(coordinate)
        )
          throw new MemoryEntriesError('INVALID_ARGUMENT', 'content cursor does not match this request')
        prior = decoded
      }
      const document = await view.get(coordinate)
      if (!document) {
        if (prior) throw new MemoryEntriesError('CONFLICT', 'memory was removed between content pages')
        return null
      }
      if (Buffer.byteLength(document.text) > view.capabilities.limits.maxItemBytes)
        throw new MemoryEntriesError('TOO_LARGE', 'memory entry exceeds the provider item budget')
      const digest = memoryDigest([document.text, document.metadata ?? null])
      if (prior && prior.digest !== digest)
        throw new MemoryEntriesError('CONFLICT', 'memory changed between content pages; read it again')
      const bytes = Buffer.from(document.text)
      const offset = prior?.offset ?? 0
      const result: MemoryEntryContent = {
        entry: { ...this.summary(view, document.summary), ref: req.ref },
        text: '',
        complete: false,
        ...(document.metadata ? { metadata: document.metadata } : {})
      }
      if (memoryJsonBytes(result) > MEMORY_ENTRY_FRAME_BYTES - CURSOR_RESERVE)
        throw new MemoryEntriesError('TOO_LARGE', 'memory metadata exceeds the response budget')
      const remainder = bytes.subarray(offset).toString('utf8')
      let low = 0
      let high = Math.min(req.maxBytes, bytes.length - offset)
      while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        const text = memoryUtf8Prefix(remainder, mid)
        if (memoryJsonBytes({ ...result, text }) <= MEMORY_ENTRY_FRAME_BYTES - CURSOR_RESERVE) low = mid
        else high = mid - 1
      }
      result.text = memoryUtf8Prefix(remainder, low)
      const end = offset + Buffer.byteLength(result.text)
      result.complete = end === bytes.length
      if (!result.complete) {
        if (end === offset) throw new MemoryEntriesError('TOO_LARGE', 'content page cannot fit one character')
        result.nextContentCursor = await this.saveCursor({
          operation: 'get',
          view: view.identity,
          coordinate,
          digest,
          offset: end,
          maxBytes: req.maxBytes
        })
      }
      return MemoryEntryContent.parse(result)
    })
  }

  async context(request: unknown = {}): Promise<MemoryContextResult> {
    const req = this.parse(MemoryContextRequest, request)
    return this.call(async () => {
      const result = MemoryContextResult.parse(await (await this.resolve()).context({ maxBytes: req.maxBytes }))
      const overview = memoryUtf8Prefix(result.overview, req.maxBytes)
      if (overview !== result.overview) result.coverage = 'partial'
      result.overview = req.seenRevision !== undefined && req.seenRevision === result.catalogRevision ? '' : overview
      while (memoryJsonBytes(result) > MEMORY_ENTRY_FRAME_BYTES) {
        result.overview = memoryUtf8Prefix(result.overview, Math.floor(Buffer.byteLength(result.overview) * 0.9))
        result.coverage = 'partial'
      }
      return result
    })
  }

  private summary(view: MemoryEntriesView, entry: EntrySummary): MemoryEntrySummary {
    const { coordinate, ...fields } = boundedSummary(entry)
    return MemoryEntrySummary.parse({
      ...fields,
      label: fields.label,
      ...(fields.description === undefined ? {} : { description: fields.description }),
      editable: fields.origin === 'active' && view.capabilities.operations.includes('update') && fields.editable,
      ref: this.tokens.ref(view.identity, coordinate)
    })
  }

  private async saveCursor(value: Continuation): Promise<string> {
    const encoded = JSON.stringify(value)
    if (Buffer.byteLength(encoded) > MAX_CONTINUATION_BYTES)
      throw new MemoryEntriesError('TOO_LARGE', 'memory continuation exceeds its durable budget')
    const token = await this.continuations.put(encoded, this.now() + CURSOR_TTL_MS)
    if (token.length > CURSOR_RESERVE - 32)
      throw new MemoryEntriesError('UNAVAILABLE', 'continuation store returned an invalid token')
    return token
  }

  private async cursor(token: string, view: string): Promise<Continuation> {
    const stored = await this.continuations.get(token, this.now())
    if (!stored) throw new MemoryEntriesError('CURSOR_EXPIRED', 'memory continuation expired; start a new request')
    const decoded = JSON.parse(stored) as Continuation
    if (decoded.view !== view)
      throw new MemoryEntriesError('STALE_BINDING', 'memory continuation belongs to another view')
    return decoded
  }

  private parse<T>(
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
    value: unknown
  ): T {
    const parsed = schema.safeParse(value)
    if (!parsed.success) throw new MemoryEntriesError('INVALID_ARGUMENT', 'invalid memory entry request')
    return parsed.data
  }

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof MemoryEntriesError) throw error
      throw new MemoryEntriesError('UNAVAILABLE', 'memory service is temporarily unavailable')
    }
  }
}
