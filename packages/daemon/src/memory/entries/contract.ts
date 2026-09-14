import type {
  MemoryContextResult,
  MemoryEntryCreateRequest,
  MemoryEntryUpdateRequest,
  MemoryEntryCapabilities,
  MemoryEntryErrorCode,
  MemoryEntrySummary
} from '@agentconnect.md/protocol'

export class MemoryEntriesError extends Error {
  constructor(
    readonly code: MemoryEntryErrorCode,
    message: string,
    readonly currentRevision?: string
  ) {
    super(message)
    this.name = 'MemoryEntriesError'
  }
}

export interface EntryCoordinate {
  partition: string
  id: string
}
export interface EntrySummary extends Omit<MemoryEntrySummary, 'ref'> {
  coordinate: EntryCoordinate
}
// A read-side graph annotation; a target inside the view carries a coordinate, a dangling one only a label.
export interface EntryLink {
  label: string
  coordinate?: EntryCoordinate
  exists: boolean
}
export interface EntryDocument {
  summary: EntrySummary
  text: string
  metadata?: Record<string, unknown>
  links?: EntryLink[]
  backlinks?: EntryLink[]
}
export interface EntryPage {
  order: 'topic' | 'backend'
  entries: EntrySummary[]
  nextCursor?: string
  catalogRevision?: string
}
export interface EntrySearchPage {
  hits: Array<{ entry: EntrySummary; snippet: string }>
  kind: 'lexical' | 'semantic' | 'hybrid' | 'unknown'
  coverage: 'complete' | 'partial' | 'unknown'
}
export interface EntryHistoryEvent {
  id?: string
  kind: 'create' | 'update' | 'delete'
  at?: string
  source?: 'tool' | 'console' | 'distill' | 'dream'
  before?: string
  after?: string
  truncated?: boolean
}
export interface EntryHistoryPage {
  events: EntryHistoryEvent[]
  nextCursor?: string
  order: 'newest-first' | 'backend'
}

// The caller resolves this view from authenticated context on every operation, including continuation.
export interface MemoryEntriesView {
  identity: string
  capabilities: MemoryEntryCapabilities
  list?(request: { cursor?: string; limit: number }): Promise<EntryPage>
  get?(coordinate: EntryCoordinate): Promise<EntryDocument | null>
  search?(request: { query: string; limit: number }): Promise<EntrySearchPage>
  history?(coordinate: EntryCoordinate, request: { cursor?: string; limit: number }): Promise<EntryHistoryPage>
  create?(request: MemoryEntryCreateRequest): Promise<EntryMutationResult>
  update?(
    coordinate: EntryCoordinate,
    request:
      | Omit<Extract<MemoryEntryUpdateRequest, { text: string }>, 'ref'>
      | Omit<Extract<MemoryEntryUpdateRequest, { edit: unknown }>, 'ref'>
  ): Promise<EntryMutationResult>
  delete?(coordinate: EntryCoordinate, request: { revision?: string }): Promise<EntryMutationResult>
  context(request: { maxBytes: number }): Promise<MemoryContextResult>
}

// Continuations are daemon-owned metadata, never a second authoritative memory store.
export interface MemoryContinuationStore {
  put(value: string, expiresAt: number): Promise<string>
  get(token: string, now: number): Promise<string | undefined>
}

export interface EntryMutationResult {
  operationId: string
  entry?: EntrySummary
  catalogRevision?: string
}
