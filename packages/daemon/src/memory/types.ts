import type { MemoryEntriesView } from './entries/contract.js'
import type { MemoryFs } from './fs.js'
import type { MemoryTextCheck } from './organization-files.js'
/** The L0 memory contract: the `MemoryProvider` port plus its scope, result, admin-surface
 *  and error types. Implementations and factories live in `provider.ts`, which re-exports
 *  everything here so existing importers stay unchanged. */
import type {
  CaptureReceipt,
  CanonicalMemoryRecord,
  MemoryEntry,
  MemoryRecallPolicy,
  MemoryPluginHistoryEvent,
  MemoryPluginOperation
} from '@agentconnect.md/protocol'
import type { RuntimeDef } from '../config/config-schema.js'
import type { ToolDescriptor } from '../tool-schema/descriptor.js'
import type { MemoryWriteSource, ManagedMemoryHistoryPage } from './store.js'
import type { DistillationTurn } from './distill.js'

export type { MemoryEntry }
export type MemoryRecord = CanonicalMemoryRecord

/** A tool's `layer` argument: the shared layer, the asker's own person layer, or the layer this conversation writes. */
export const MEMORY_LAYER_CHOICES = ['shared', 'person', 'here'] as const
export type MemoryLayerChoice = (typeof MEMORY_LAYER_CHOICES)[number]

/** The provider kind an agent is configured with (protocol `memory.provider`). */
export type MemoryProviderKind = 'none' | 'native' | 'managed' | 'external'

/** Every memory op's context: the agent, and at most one layer beside its shared store (memory/layers.ts). */
export interface MemoryScope {
  // Trusted daemon-minted source-turn identity, never selected by model arguments.
  sourceTurnId?: string
  agentId: string
  /** Act on exactly this store instead of resolving one from the agent + channel.
   *  A dream binds its STAGED store here, so the same memory tools serve it without
   *  the provider needing to know what a dream is. */
  root?: MemoryFs
  /** A filesystem-safe place-layer folder name (channel + transport scope), set only by the daemon. */
  channelKey?: string
  /** The place's channel id, recorded beside a place layer so the console can name it; only with `channelKey`. */
  channel?: string
  transportScope?: string
  /** The place's platform id, recorded the same way. */
  platform?: string
  /** The place's display name when the scope was resolved, recorded the same way. */
  channelName?: string
  /** A filesystem-safe person-layer folder name, set only by the daemon. */
  personKey?: string
  /** A shared place's own older folder: read beneath the shared store, never written. */
  sharedPlace?: true
  /** Read only the layer writes land in, without the overlay (a tool's `layer` argument). */
  alone?: true
  userId?: string
  sessionId?: string
  /** The conversation may hold people from outside the organization, or its audience is not known: People is withheld (assistant-mode.md §5.16). Absent counts as true. */
  withOutsiders?: boolean
  /** Who a write of the organization record comes from; absent is a conversation's. */
  recordWriter?: import('@agentconnect.md/protocol').KnowledgeRecordWriterKind
  /** The console's view: the organization record's names are left out of the shared layer, kept on the Knowledge page (assistant-mode.md §5.16). */
  withoutRecord?: true
}

/** Result of the `readMemory` tool path — the whole file's text. */
export interface MemoryReadResult {
  path: string
  content: string
}

/** Result of the `writeMemory` tool path. */
export interface MemoryWriteResult {
  ok: true
  path: string
  size: number
  mtime: string
}

/** A finished user/agent turn. Managed consumes it only when autoDistill is enabled. */
export interface TurnRecord extends DistillationTurn {
  /** Stable across retries/restarts; external capture uses it as its operation fence. */
  turnId?: string
  sessionId?: string
}
/** Runs one extraction turn in the ORIGINATING conversation's scope, so its writes land in that conversation's layer. */
export type MemoryExtractor = (agentId: string, prompt: string, scope?: MemoryScope) => Promise<string>

export interface RecallRequest {
  turnId: string
  query: string
  topK: number
  maxBytes: number
  timeoutMs: number
  /** Core aborts this on turn cancellation or the recall deadline. */
  signal?: AbortSignal
}

export type RecallPolicy = MemoryRecallPolicy

/** One hop of the `[[name]]` memory graph around a file (#41). */
export interface MemoryNeighborsResult {
  links: { name: string; topic: string; description?: string; exists: boolean }[]
  backlinks: { name: string; topic: string; description?: string; exists: boolean }[]
}

/** A write's opt-out changes for the organization record's People: keys to mark before it lands, keys to lift after (§5.16). */
export interface MemoryOptOutChange {
  mark: string[]
  lift: string[]
}

/** A check a managed entry write passes inside its lock, with the topic's text before and after; it throws to refuse, and for the record it returns the opt-out changes. */
export type MemoryWriteGuard = (
  topic: string,
  before: string | null,
  after: string | null
) => Promise<void | MemoryOptOutChange>

export interface FileMemoryAdmin {
  shape: 'files'
  list(scope: MemoryScope): Promise<MemoryEntry[]>
  read(scope: MemoryScope, path: string): Promise<MemoryReadResult>
  write(
    scope: MemoryScope,
    path: string,
    content: string,
    ifMatch?: string,
    source?: MemoryWriteSource
  ): Promise<MemoryWriteResult>
  /** Present only when this file provider owns a provenance sidecar. */
  history?(scope: MemoryScope, req: { path: string; cursor?: string; limit: number }): Promise<ManagedMemoryHistoryPage>
}

export interface MemoryRecordPage {
  records: MemoryRecord[]
  nextCursor?: string
}

export interface MemoryRecordHistoryPage {
  events: MemoryPluginHistoryEvent[]
  nextCursor?: string
}

/**
 * Backend-neutral record administration implemented by external providers.
 * Scope is always supplied by daemon core; it is never a model/plugin-selected
 * field. M-5C projects these methods onto the stable tools/REST surface.
 */
export interface RecordMemoryAdmin {
  shape: 'records'
  capabilities: ReadonlySet<MemoryPluginOperation>
  search(scope: MemoryScope, req: RecallRequest): Promise<MemoryRecord[]>
  list(scope: MemoryScope, req: { cursor?: string; limit: number }): Promise<MemoryRecordPage>
  get(scope: MemoryScope, id: string): Promise<MemoryRecord | null>
  create(
    scope: MemoryScope,
    req: { operationId: string; text: string; metadata?: Record<string, unknown> }
  ): Promise<MemoryRecord>
  update(
    scope: MemoryScope,
    req: {
      operationId: string
      id: string
      text: string
      metadata?: Record<string, unknown>
      version?: string
    }
  ): Promise<MemoryRecord>
  delete(scope: MemoryScope, req: { operationId: string; id: string; version?: string }): Promise<boolean>
  history(scope: MemoryScope, req: { id: string; cursor?: string; limit: number }): Promise<MemoryRecordHistoryPage>
}

export type MemoryAdminSurface = FileMemoryAdmin | RecordMemoryAdmin | null

/**
 * The port. Every method is scope-carrying so a later provider can partition by
 * user/session without a signature change.
 */
export interface MemoryProvider {
  readonly kind: MemoryProviderKind

  // Additive read contract; native and none keep their own lifecycle and expose no entries.
  /** `check` refuses a managed write's final text before it is stored (the organization files' shapes); `guard` then sees the text before and after (the people directory's rules); record backends ignore both. */
  entryView?(
    scope: MemoryScope,
    writeSource?: MemoryWriteSource,
    check?: MemoryTextCheck,
    guard?: MemoryWriteGuard
  ): Promise<MemoryEntriesView | null>

  /** Env delta for the runtime child: `managed`/`none`/`external` turn its own memory off, `native` adds nothing (see `memoryProviderFor`). */
  runtimeEnv(runtime: RuntimeDef, effectiveEnv?: NodeJS.ProcessEnv, runtimeId?: string): Record<string, string>

  /** Seed a brand-new agent's memory so injection and the tools always have a
   *  target (idempotent). Called once per session handle before prompt building. */
  ensure(scope: MemoryScope, agentName: string): Promise<void>

  /** The text to inject at the start of a FRESH session (the memory index, capped).
   *  '' when there is nothing to inject. The caller owns the surrounding prompt prose. */
  standingContextAtSessionStart(scope: MemoryScope): Promise<string>

  /** Query-dependent recall for EVERY activation. Non-semantic providers return []. */
  recallForTurn(scope: MemoryScope, req: RecallRequest): Promise<MemoryRecord[]>

  /** Effective auto-recall policy for this agent. External tool-only bindings
   * return mode=tool-only so core skips the per-turn data-plane call entirely. */
  recallPolicy(scope: MemoryScope): RecallPolicy

  /** Record one finished turn. Called through the provider-neutral post-turn queue. */
  recordTurn(scope: MemoryScope, turn: TurnRecord): Promise<CaptureReceipt | void>

  /** Core-owned model tools for one agent. Raw plugin tool names never cross here. */
  toolsForAgent(agentId: string): ToolDescriptor[]

  /** File | record | none console shape. Backend identity never leaks into it. */
  adminSurface(): MemoryAdminSurface

  /** Agent-scoped variant implemented by the dispatcher. Tool/CP callers must
   * prefer this when their `MemoryProvider` can serve more than one agent. */
  adminSurfaceForAgent?(agentId: string): MemoryAdminSurface

  /** One hop of the memory graph around a file. Only the managed file store has a
   *  graph; other providers omit it and callers degrade to no related links. */
  neighbors?(scope: MemoryScope, path: string): Promise<MemoryNeighborsResult>

  /** @deprecated migration alias; live injection uses toolsForAgent. */
  tools(): ToolDescriptor[]

  list(scope: MemoryScope): Promise<MemoryEntry[]>
  read(scope: MemoryScope, path: string): Promise<MemoryReadResult>
  write(
    scope: MemoryScope,
    path: string,
    content: string,
    ifMatch?: string,
    source?: MemoryWriteSource
  ): Promise<MemoryWriteResult>
}

/** Thrown when a provider can't be built for an agent (e.g. an external
 * connection has not passed admission, or native/off-switch env levers are unverified). */
export class MemoryProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryProviderUnavailableError'
  }
}
