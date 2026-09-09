import { canonicalAgentMemoryKey } from '../keys.js'
import type { MemoryContextResult, MemoryEntryCapabilities } from '@agentconnect.md/protocol'
import type { MemoryRecord, MemoryScope, RecordMemoryAdmin } from '../types.js'
import {
  MemoryEntriesError,
  type EntryCoordinate,
  type EntryDocument,
  type EntryPage,
  type EntrySummary,
  type MemoryEntriesView
} from './contract.js'
import { memoryDigest, memoryUtf8Prefix } from './service.js'

export class ExternalMemoryEntries implements MemoryEntriesView {
  readonly identity: string
  readonly capabilities: MemoryEntryCapabilities

  constructor(
    private readonly admin: RecordMemoryAdmin,
    private readonly scope: MemoryScope,
    bindingGeneration: string,
    limits: { maxItemBytes: number; maxPageItems: number }
  ) {
    if (scope.root || scope.channelKey)
      throw new MemoryEntriesError('UNSUPPORTED', 'external memory supports agent scope only')
    this.identity = memoryDigest(['external', scope.agentId, bindingGeneration])
    this.capabilities = {
      version: 1,
      operations: [
        ...(admin.capabilities.has('list') ? ['list' as const] : []),
        ...(admin.capabilities.has('get') ? ['get' as const] : [])
      ],
      supportedScopes: ['agent'],
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
    if (coordinate.partition !== 'agent')
      throw new MemoryEntriesError('STALE_BINDING', 'external memory partition is outside this view')
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

  async context(): Promise<MemoryContextResult> {
    return { freshness: 'unknown', coverage: 'unavailable', overview: '' }
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
      editable: false
    }
  }
}
