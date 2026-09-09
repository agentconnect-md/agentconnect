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
export interface EntryDocument {
  summary: EntrySummary
  text: string
  metadata?: Record<string, unknown>
}
export interface EntryPage {
  order: 'topic' | 'backend'
  entries: EntrySummary[]
  nextCursor?: string
  catalogRevision?: string
}

// The caller resolves this view from authenticated context on every operation, including continuation.
export interface MemoryEntriesView {
  identity: string
  capabilities: MemoryEntryCapabilities
  list?(request: { cursor?: string; limit: number }): Promise<EntryPage>
  get?(coordinate: EntryCoordinate): Promise<EntryDocument | null>
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
