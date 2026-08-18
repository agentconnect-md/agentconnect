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
import type { ToolDescriptor } from '../mcp/tool-descriptor.js'
import type { MemoryWriteSource, ManagedMemoryHistoryPage } from './store.js'
import type { DistillationTurn } from './distill.js'

export type { MemoryEntry }
export type MemoryRecord = CanonicalMemoryRecord

/** The provider kind an agent is configured with (protocol `memory.provider`). */
export type MemoryProviderKind = 'none' | 'native' | 'managed' | 'external'

/** The context key every memory op carries. `managed` routes by `agentId`, and by
 *  `channelKey` when the agent's memory scope is `channel` (#653): reads overlay the
 *  agent-level base + the channel folder, writes/capture go to the channel folder.
 *  `userId`/`sessionId` are reserved for later providers. */
export interface MemoryScope {
  agentId: string
  /** A filesystem-safe per-channel folder name (channel + transport scope), set by
   *  the daemon only for channel-scoped agents. Absent ⇒ agent-level store. */
  channelKey?: string
  /** Raw source identity for the channel folder, recorded once so the console can
   *  render a name instead of the opaque key. Only meaningful with `channelKey`. */
  channel?: string
  transportScope?: string
  userId?: string
  sessionId?: string
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
export type MemoryExtractor = (agentId: string, prompt: string) => Promise<string>

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

  /** Env delta to merge into the runtime child so its OWN memory goes where this
   *  provider wants it: `managed` disables it; `native` redirects it under the
   *  agent root; applied by `daemon.ts` at spawn (see `memoryProviderFor`). */
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
