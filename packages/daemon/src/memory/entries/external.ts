import { randomUUID } from 'node:crypto'
import { canonicalAgentMemoryKey } from '../keys.js'
import type {
  MemoryContextResult,
  MemoryEntryCapabilities,
  MemoryEntryCreateRequest,
  MemoryEntryUpdateRequest
} from '@agentconnect.md/protocol'
import {
  MemoryProviderUnavailableError,
  type MemoryRecord,
  type MemoryScope,
  type RecordMemoryAdmin
} from '../types.js'
import { MemoryConflictError, MemoryTooLargeError, type MemoryWriteSource } from '../store.js'
import {
  MemoryEntriesError,
  type EntryCoordinate,
  type EntryDocument,
  type EntryMutationResult,
  type EntryPage,
  type EntrySearchPage,
  type EntrySummary,
  type MemoryEntriesView
} from './contract.js'
import { memoryDigest, memoryUtf8Prefix } from './service.js'

const WRITE_OPERATIONS = ['create', 'update', 'delete'] as const

export class ExternalMemoryEntries implements MemoryEntriesView {
  readonly identity: string
  readonly capabilities: MemoryEntryCapabilities

  constructor(
    private readonly admin: RecordMemoryAdmin,
    private readonly scope: MemoryScope,
    bindingGeneration: string,
    limits: { maxItemBytes: number; maxPageItems: number },
    private readonly writeContext?: { source: MemoryWriteSource }
  ) {
    if (scope.root || scope.channelKey)
      throw new MemoryEntriesError('UNSUPPORTED', 'external memory supports agent scope only')
    this.identity = memoryDigest(['external', scope.agentId, bindingGeneration])
    this.capabilities = {
      version: 1,
      operations: [
        ...(admin.capabilities.has('list') ? ['list' as const] : []),
        ...(admin.capabilities.has('get') ? ['get' as const] : []),
        ...(admin.capabilities.has('recall') ? ['search' as const] : []),
        ...(writeContext ? WRITE_OPERATIONS.filter((operation) => admin.capabilities.has(operation)) : [])
      ],
      // A v1 manifest does not declare its retrieval kind, so no lexical/semantic claim is made.
      supportedScopes: ['agent'],
      // A v1 plugin proves neither atomic conditional writes nor exact storage of authored text.
      writeConsistency: 'last-write-wins',
      exactEdit: false,
      exactCreate: false,
      enumeration: admin.capabilities.has('list') ? 'live' : 'unavailable',
      graph: false,
      limits: { maxItemBytes: limits.maxItemBytes, maxPageItems: Math.min(100, limits.maxPageItems) }
    }
  }

  async list(request: { cursor?: string; limit: number }): Promise<EntryPage> {
    const page = await this.admin.list(this.scope, {
      ...request,
      limit: Math.min(request.limit, this.capabilities.limits.maxPageItems)
    })
    return {
      order: 'backend',
      entries: page.records.map((record) => this.summary(record)),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
    }
  }

  async get(coordinate: EntryCoordinate): Promise<EntryDocument | null> {
    this.checkPartition(coordinate)
    const record = await this.admin.get(this.scope, coordinate.id)
    if (!record) return null
    if (record.id !== coordinate.id)
      throw new MemoryEntriesError('UNAVAILABLE', 'provider returned a different memory entry')
    return {
      summary: this.summary(record),
      text: record.text,
      ...(record.metadata ? { metadata: record.metadata } : {})
    }
  }

  async search(request: { query: string; limit: number }): Promise<EntrySearchPage> {
    if (!this.capabilities.operations.includes('search'))
      throw new MemoryEntriesError('UNSUPPORTED', 'memory search is unavailable')
    let records: MemoryRecord[]
    try {
      records = await this.admin.search(this.scope, {
        turnId: randomUUID(),
        query: request.query,
        topK: Math.min(request.limit, 20),
        maxBytes: 16_384,
        timeoutMs: 3_000
      })
    } catch (error) {
      if (error instanceof MemoryTooLargeError) throw new MemoryEntriesError('TOO_LARGE', error.message)
      throw new MemoryEntriesError('UNAVAILABLE', 'memory search is temporarily unavailable')
    }
    return {
      kind: 'unknown',
      coverage: 'unknown',
      hits: records.slice(0, request.limit).map((record) => ({
        entry: this.summary(record),
        snippet: memoryUtf8Prefix(record.text.replace(/\s+/g, ' ').trim(), 240)
      }))
    }
  }

  async create(request: MemoryEntryCreateRequest): Promise<EntryMutationResult> {
    if (request.label !== undefined)
      throw new MemoryEntriesError(
        'INVALID_ARGUMENT',
        'this memory backend stores records without names; leave the name empty'
      )
    this.checkWritePayload('create', request.text)
    const operationId = randomUUID()
    const record = await this.mutate(() =>
      this.admin.create(this.scope, {
        operationId,
        text: request.text,
        ...(request.metadata ? { metadata: request.metadata } : {})
      })
    )
    return { operationId, entry: this.summary(record) }
  }

  async update(
    coordinate: EntryCoordinate,
    request:
      | Omit<Extract<MemoryEntryUpdateRequest, { text: string }>, 'ref'>
      | Omit<Extract<MemoryEntryUpdateRequest, { edit: unknown }>, 'ref'>
  ): Promise<EntryMutationResult> {
    this.checkPartition(coordinate)
    if (!('text' in request))
      throw new MemoryEntriesError(
        'UNSUPPORTED',
        'this memory backend cannot apply exact edits; send the full replacement text'
      )
    this.checkWritePayload('update', request.text)
    const operationId = randomUUID()
    // Omitted metadata is forwarded as omitted so the backend preserves what it holds.
    const record = await this.mutate(
      () =>
        this.admin.update(this.scope, {
          operationId,
          id: coordinate.id,
          text: request.text,
          ...(request.metadata ? { metadata: request.metadata } : {}),
          ...(request.revision ? { version: request.revision } : {})
        }),
      coordinate
    )
    if (record.id !== coordinate.id)
      throw new MemoryEntriesError('UNAVAILABLE', 'provider returned a different memory entry')
    return { operationId, entry: this.summary(record) }
  }

  async delete(coordinate: EntryCoordinate, request: { revision?: string }): Promise<EntryMutationResult> {
    this.checkPartition(coordinate)
    this.requireWrite('delete')
    const operationId = randomUUID()
    const deleted = await this.mutate(
      () =>
        this.admin.delete(this.scope, {
          operationId,
          id: coordinate.id,
          ...(request.revision ? { version: request.revision } : {})
        }),
      coordinate
    )
    if (!deleted) throw new MemoryEntriesError('NOT_FOUND', 'memory entry does not exist')
    return { operationId }
  }

  async context(): Promise<MemoryContextResult> {
    return { freshness: 'unknown', coverage: 'unavailable', overview: '' }
  }

  private checkPartition(coordinate: EntryCoordinate) {
    if (coordinate.partition !== 'agent')
      throw new MemoryEntriesError('STALE_BINDING', 'external memory partition is outside this view')
  }

  private requireWrite(operation: (typeof WRITE_OPERATIONS)[number]) {
    if (!this.writeContext || !this.capabilities.operations.includes(operation))
      throw new MemoryEntriesError('UNSUPPORTED', 'memory entry mutations are unavailable')
  }

  // Refuse what the v1 record contract cannot express before any bytes leave the daemon.
  private checkWritePayload(operation: 'create' | 'update', text: string) {
    this.requireWrite(operation)
    if (text.length === 0)
      throw new MemoryEntriesError('INVALID_ARGUMENT', 'memory record text cannot be empty; delete the entry instead')
    if (Buffer.byteLength(text) > this.capabilities.limits.maxItemBytes)
      throw new MemoryEntriesError('TOO_LARGE', 'memory entry exceeds the provider item budget')
  }

  private async mutate<T>(call: () => Promise<T>, coordinate?: EntryCoordinate): Promise<T> {
    try {
      return await call()
    } catch (error) {
      if (error instanceof MemoryEntriesError) throw error
      if (error instanceof MemoryConflictError)
        throw new MemoryEntriesError(
          'CONFLICT',
          'memory entry revision changed; read it again before editing',
          await this.currentRevision(coordinate)
        )
      if (error instanceof MemoryTooLargeError) throw new MemoryEntriesError('TOO_LARGE', error.message)
      if (error instanceof MemoryProviderUnavailableError) throw new MemoryEntriesError('UNAVAILABLE', error.message)
      // The backend may have applied the write before the reply was lost; a v1 plugin cannot prove otherwise.
      throw new MemoryEntriesError(
        'AMBIGUOUS_WRITE',
        'memory mutation outcome is unconfirmed; read current state before retrying'
      )
    }
  }

  private async currentRevision(coordinate?: EntryCoordinate): Promise<string | undefined> {
    if (!coordinate || !this.admin.capabilities.has('get')) return undefined
    try {
      const record = await this.admin.get(this.scope, coordinate.id)
      return record?.id === coordinate.id ? record.version : undefined
    } catch {
      return undefined
    }
  }

  private summary(record: MemoryRecord): EntrySummary {
    if (record.scope.kind !== 'agent' || record.scope.key !== canonicalAgentMemoryKey(this.scope.agentId))
      throw new MemoryEntriesError('UNAVAILABLE', 'provider returned memory outside the authorized scope')
    return {
      coordinate: { partition: 'agent', id: record.id },
      label: memoryUtf8Prefix(record.text.replace(/\s+/g, ' ').trim(), 160),
      format: 'text',
      byteSize: Buffer.byteLength(record.text),
      ...(record.createdAt ? { createdAt: record.createdAt } : {}),
      ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
      ...(record.version ? { revision: record.version } : {}),
      origin: 'active',
      editable: this.capabilities.operations.includes('update')
    }
  }
}
