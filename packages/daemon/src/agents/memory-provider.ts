/**
 * `MemoryProvider` — the pluggable seam behind an agent's long-term memory.
 *
 * The daemon drives a provider at the existing hook points: it seeds/injects the
 * memory index at session start, exposes the memory tools, serves list/read/write
 * for both the agent (MCP tools) and the console, and contributes the runtime-env
 * delta that decides where the runtime's OWN memory lives. Making this a port lets
 * memory be backed three ways (design: docs/designs/memory-evolution.md):
 *
 *   - `managed`  — our directory (`<agent-root>/memory/`), the default. The runtime's
 *     own memory is DISABLED so there's one store.
 *   - `native`   — the runtime's own memory (Claude auto-memory / Codex memories),
 *     REDIRECTED under the agent root (via env) for per-agent isolation. We don't
 *     inject or expose tools — the runtime manages and loads it itself.
 *   - `external` — an out-of-process memory plugin (for example Mem0).
 *
 * Per-agent selection: each agent carries `memory.provider`. The daemon holds a
 * `DispatchingMemoryProvider` that routes every scope-bearing call to the agent's
 * configured concrete provider. The one non-scoped seam is `runtimeEnv` (it needs
 * the agent root + the concrete runtime), applied directly in `daemon.ts` where the
 * full agent is in hand — see `memoryProviderFor`.
 *
 * The CP frame path keeps its own byte-sliced reader (`cp/memory-reader.ts`): its
 * UTF-8-boundary + frame-budget slicing is a wire-transport concern that must not
 * leak into this storage-domain port. `read()` here is whole-file (MCP semantics).
 */
import type {
  AgentMemoryBinding,
  CaptureReceipt,
  CanonicalMemoryRecord,
  ExternalMemoryBinding,
  MemoryEntry,
  MemoryConnectionSpec,
  MemoryRecallPolicy,
  MemoryPluginHistoryEvent,
  MemoryPluginOperation
} from '@agentconnect.md/protocol'
import { randomUUID } from 'node:crypto'
import type { RuntimeDef } from '../config/config-schema.js'
import type { ToolDescriptor } from '../mcp/tools.js'
import { MEMORY_TOOLS, externalMemoryTools } from '../mcp/tools.js'
import {
  ensureMemory,
  readIndex,
  readMemoryFileIfPresent,
  writeMemoryFile,
  listMemory,
  listMemoryHistory,
  channelMemoryRoot,
  writeChannelMemoryMeta,
  MEMORY_INDEX,
  MemoryConflictError,
  MemoryTooLargeError,
  type MemoryFile,
  type MemoryFs,
  type MemoryWriteSource,
  type ManagedMemoryHistoryPage
} from './memory.js'
import {
  nativeMemoryList,
  nativeMemoryRead,
  nativeMemoryWrite,
  nativeRuntimeEnv,
  isNativeRuntimeSupported
} from './native-memory.js'
import {
  appendDistilledMemories,
  buildDistillationPrompt,
  parseDistilledMemories,
  type DistillationTurn
} from './memory-distiller.js'
import { describeRuntime, runtimeMemoryDisabledEnv } from './runtime-memory.js'
import { canonicalAgentMemoryKey } from './memory-recall.js'
import type { MemoryCaptureConnectionRegistry, MemoryCaptureOutbox } from '../memory-plugin/outbox.js'
import { defaultMemoryPluginMetrics, type MemoryPluginMetrics } from '../memory-plugin/metrics.js'
import { MemoryPluginConflictError, MemoryPluginInputError, type MemoryPluginClient } from '../memory-plugin/client.js'

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

/**
 * Apply the centralized runtime-memory policy. `managed` remains available for an
 * unclassified harness (our store still works), while `none` must fail closed: it
 * cannot promise "no persistent memory" without a verified native off-switch.
 */
function disabledRuntimeMemoryEnv(
  runtime: RuntimeDef,
  effectiveEnv: NodeJS.ProcessEnv,
  runtimeId: string | undefined,
  requiredFor?: 'none' | 'external'
): Record<string, string> {
  let env: Record<string, string> | undefined
  try {
    env = runtimeMemoryDisabledEnv(runtime, effectiveEnv, runtimeId)
  } catch (error) {
    throw new MemoryProviderUnavailableError(error instanceof Error ? error.message : String(error))
  }
  if (env) return env
  if (requiredFor) {
    throw new MemoryProviderUnavailableError(
      `${requiredFor} memory is not supported for this runtime (off-switch unverified): ${describeRuntime(runtime, runtimeId)}; use managed or register a verified runtime-memory policy`
    )
  }
  return {}
}

/**
 * `managed` memory: our `<root>/memory/` directory. A thin facade over
 * `agents/memory.ts` — every method delegates to the existing primitive and lets
 * its error classes (`MemoryPathError` / `MemoryTooLargeError` /
 * `MemoryConflictError`) propagate raw, so the MCP + CP error mappings are unchanged.
 * Where the tree IS (this disk, a sandbox volume) is the factory's answer: it hands
 * back the port and may refuse with `MemorySandboxUnavailableError`.
 */
export class ManagedMemoryProvider implements MemoryProvider {
  readonly kind = 'managed' as const

  /** `memoryFsFor` resolves an agent id → the port over its memory tree (holds
   *  `memory/`), or undefined for an unknown agent. */
  constructor(
    private readonly memoryFsFor: (agentId: string) => MemoryFs | undefined,
    private readonly autoDistillFor: (agentId: string) => boolean = () => false,
    private readonly extract?: MemoryExtractor
  ) {}

  private rootFor(agentId: string): MemoryFs {
    const fs = this.memoryFsFor(agentId)
    // Match the pre-provider MCP path's message verbatim (mcp/ops.ts) so the tool
    // error surface is byte-identical.
    if (!fs) throw new Error(`unknown agent ${agentId}`)
    return fs
  }

  /** The write/active memory root: the channel folder when channel-scoped, else the
   *  agent base. All WRITES (tools + distillation) target this so a channel's
   *  content never lands in another channel or the shared base (#653). */
  private activeRoot(scope: MemoryScope): MemoryFs {
    const base = this.rootFor(scope.agentId)
    return scope.channelKey ? channelMemoryRoot(base, scope.channelKey) : base
  }

  /** The read overlay roots, most-specific first — `[channel, base]` when channel-
   *  scoped so the channel layer shadows the shared base per file; `[base]`
   *  otherwise. */
  private readRoots(scope: MemoryScope): MemoryFs[] {
    const base = this.rootFor(scope.agentId)
    return scope.channelKey ? [channelMemoryRoot(base, scope.channelKey), base] : [base]
  }

  // Managed keeps a single store: turn OFF any verified runtime-owned memory so
  // the agent doesn't end up with two competing stores. Unknown harnesses retain
  // managed support; adding a real native-memory feature requires a registry entry.
  runtimeEnv(runtime: RuntimeDef, effectiveEnv: NodeJS.ProcessEnv = {}, runtimeId?: string): Record<string, string> {
    return disabledRuntimeMemoryEnv(runtime, effectiveEnv, runtimeId)
  }

  async ensure(scope: MemoryScope, agentName: string): Promise<void> {
    await ensureMemory(this.activeRoot(scope), agentName)
    // Record the source identity of a channel folder once, so the console can name
    // it. Best-effort and off the critical path — a failure never blocks memory.
    if (scope.channelKey && scope.channel) {
      void writeChannelMemoryMeta(this.rootFor(scope.agentId), scope.channelKey, {
        channel: scope.channel,
        ...(scope.transportScope ? { transportScope: scope.transportScope } : {})
      }).catch(() => {})
    }
  }

  async standingContextAtSessionStart(scope: MemoryScope): Promise<string> {
    // Overlay: inject the shared base index first, then the channel index, so the
    // agent sees "shared knowledge + this channel" as one memory (#653).
    const ordered = [...this.readRoots(scope)].reverse() // [base] or [base, channel]
    const parts: string[] = []
    for (const root of ordered) {
      const index = (await readIndex(root)).trim()
      if (index) parts.push(index)
    }
    return parts.join('\n\n')
  }

  async recallForTurn(): Promise<MemoryRecord[]> {
    return []
  }

  recallPolicy(): RecallPolicy {
    return { mode: 'auto', topK: 5, maxBytes: 8 * 1024, timeoutMs: 1_000 }
  }

  async recordTurn(scope: MemoryScope, turn: TurnRecord): Promise<void> {
    if (!this.autoDistillFor(scope.agentId) || !this.extract) return
    // Per-turn distillation is a WRITE: it goes to the active (channel) folder so a
    // channel's turns never distill into the shared base or another channel (#653).
    const dir = this.activeRoot(scope)
    const prompt = await buildDistillationPrompt(dir, turn)
    const output = await this.extract(scope.agentId, prompt)
    await appendDistilledMemories(dir, parseDistilledMemories(output))
  }

  tools(): ToolDescriptor[] {
    return MEMORY_TOOLS
  }

  toolsForAgent(): ToolDescriptor[] {
    return MEMORY_TOOLS
  }

  adminSurface(): FileMemoryAdmin {
    return {
      shape: 'files',
      list: (scope) => this.list(scope),
      read: (scope, path) => this.read(scope, path),
      write: (scope, path, content, ifMatch, source) => this.write(scope, path, content, ifMatch, source),
      history: (scope, req) => listMemoryHistory(this.activeRoot(scope), req.path, req.cursor, req.limit)
    }
  }

  async list(scope: MemoryScope): Promise<MemoryEntry[]> {
    const roots = this.readRoots(scope)
    if (roots.length === 1) return listMemory(roots[0]!)
    // Union base + channel, channel shadowing the base by name, MEMORY.md first.
    const byName = new Map<string, MemoryFile>()
    for (const root of [...roots].reverse()) {
      for (const file of await listMemory(root)) byName.set(file.name, file)
    }
    return [...byName.values()].sort((a, b) =>
      a.name === MEMORY_INDEX ? -1 : b.name === MEMORY_INDEX ? 1 : a.name.localeCompare(b.name)
    )
  }

  async read(scope: MemoryScope, path: string): Promise<MemoryReadResult> {
    // Channel layer shadows the base: return the first root that HAS the file.
    // Existence (not emptiness) decides — an intentionally-empty channel file must
    // still shadow a non-empty base file rather than fall through.
    for (const root of this.readRoots(scope)) {
      const content = await readMemoryFileIfPresent(root, path)
      if (content !== null) return { path, content }
    }
    return { path, content: '' }
  }

  async write(
    scope: MemoryScope,
    path: string,
    content: string,
    ifMatch?: string,
    source?: MemoryWriteSource
  ): Promise<MemoryWriteResult> {
    const { size, mtime } = await writeMemoryFile(this.activeRoot(scope), path, content, ifMatch, source)
    return { ok: true, path, size, mtime }
  }
}

/**
 * No persistent memory. Runtime-native memory is explicitly disabled and the
 * daemon contributes no store, prompt injection, distillation, or MCP tools.
 */
export class NoMemoryProvider implements MemoryProvider {
  readonly kind = 'none' as const

  runtimeEnv(runtime: RuntimeDef, effectiveEnv: NodeJS.ProcessEnv = {}, runtimeId?: string): Record<string, string> {
    return disabledRuntimeMemoryEnv(runtime, effectiveEnv, runtimeId, 'none')
  }

  async ensure(): Promise<void> {}

  async standingContextAtSessionStart(): Promise<string> {
    return ''
  }

  async recallForTurn(): Promise<MemoryRecord[]> {
    return []
  }

  recallPolicy(): RecallPolicy {
    return { mode: 'auto', topK: 5, maxBytes: 8 * 1024, timeoutMs: 1_000 }
  }

  async recordTurn(): Promise<void> {}

  tools(): ToolDescriptor[] {
    return []
  }

  toolsForAgent(): ToolDescriptor[] {
    return []
  }

  adminSurface(): null {
    return null
  }

  async list(): Promise<MemoryEntry[]> {
    return []
  }

  async read(_scope: MemoryScope, path: string): Promise<MemoryReadResult> {
    throw new MemoryProviderUnavailableError(`persistent memory is disabled; cannot read ${path}`)
  }

  async write(_scope: MemoryScope, path: string): Promise<MemoryWriteResult> {
    throw new MemoryProviderUnavailableError(`persistent memory is disabled; cannot write ${path}`)
  }
}

/**
 * `native` memory: the runtime's OWN memory (Claude auto-memory / Codex memories),
 * redirected under the agent root via `runtimeEnv` for per-agent isolation. The
 * runtime writes and loads it itself, so we do NOT seed, inject, or expose tools —
 * doing so would create a second store the runtime never reads. `list`/`read`/`write`
 * surface the runtime's memory files for the console (see native-memory.ts).
 *
 * The per-runtime env levers are an explicit registry (native-memory.ts). An agent
 * selecting `native` on a runtime whose levers aren't registered fails loudly at
 * construction rather than silently mis-setting env — we don't guess env for a
 * runtime we haven't verified.
 */
export class NativeMemoryProvider implements MemoryProvider {
  readonly kind = 'native' as const

  constructor(
    private readonly agentDirByAgent: (agentId: string) => string | undefined,
    private readonly runtimeFor: (agentId: string) => RuntimeDef | undefined
  ) {}

  private dirFor(agentId: string): string {
    const dir = this.agentDirByAgent(agentId)
    if (!dir) throw new Error(`unknown agent ${agentId}`)
    return dir
  }

  runtimeEnv(_runtime: RuntimeDef): Record<string, string> {
    // Not the live path: the spawn env is sourced via memoryProviderFor (which binds
    // the agent root). Routing it through the dispatcher/interface here would lack
    // the root, so make the misuse obvious.
    throw new Error('NativeMemoryProvider.runtimeEnv must not be called — use memoryProviderFor at spawn')
  }

  async ensure(): Promise<void> {
    // The runtime manages its own memory — nothing to seed.
  }

  async standingContextAtSessionStart(): Promise<string> {
    // The runtime loads its own memory; don't double-inject.
    return ''
  }

  async recallForTurn(): Promise<MemoryRecord[]> {
    return []
  }

  recallPolicy(): RecallPolicy {
    return { mode: 'auto', topK: 5, maxBytes: 8 * 1024, timeoutMs: 1_000 }
  }

  async recordTurn(): Promise<void> {
    // no per-turn distillation.
  }

  tools(): ToolDescriptor[] {
    // The runtime has its own memory mechanism; our tools would target a different
    // store than it reads. Expose none.
    return []
  }

  toolsForAgent(): ToolDescriptor[] {
    return []
  }

  adminSurface(): FileMemoryAdmin {
    return {
      shape: 'files',
      list: (scope) => this.list(scope),
      read: (scope, path) => this.read(scope, path),
      write: (scope, path, content, ifMatch, source) => this.write(scope, path, content, ifMatch, source)
    }
  }

  async list(scope: MemoryScope): Promise<MemoryEntry[]> {
    return nativeMemoryList(this.dirFor(scope.agentId), this.runtimeFor(scope.agentId))
  }

  async read(scope: MemoryScope, path: string): Promise<MemoryReadResult> {
    return nativeMemoryRead(this.dirFor(scope.agentId), this.runtimeFor(scope.agentId), path)
  }

  async write(
    scope: MemoryScope,
    path: string,
    content: string,
    ifMatch?: string,
    _source?: MemoryWriteSource
  ): Promise<MemoryWriteResult> {
    // native writes go to the runtime's own store — no managed `.history` log there.
    return nativeMemoryWrite(this.dirFor(scope.agentId), this.runtimeFor(scope.agentId), path, content, ifMatch)
  }
}

export interface ExternalMemoryRuntimeDeps {
  registry: MemoryCaptureConnectionRegistry
  outbox: Pick<MemoryCaptureOutbox, 'enqueue'>
  metrics?: MemoryPluginMetrics
  now?: () => number
}

/**
 * Secret-free connection definition captured at turn admission. Capturing this
 * before the model runs makes the post-delivery enqueue independent of a
 * concurrent provider/connection reconfiguration: an old turn is either sent
 * through its original definition or fenced by the outbox, never retargeted.
 */
export interface PreparedExternalMemoryCapture {
  connectionId: string
  connectionRevision: number
  pluginId: string
  manifestDigest: string
  config: Record<string, unknown>
  idempotency: 'operation-id' | 'none'
}

/**
 * Backend-neutral external provider. It derives the only v1 scope from the
 * trusted agent id, applies the binding's bounded recall policy, and turns
 * post-delivery captures into durable outbox rows. Raw plugin tools, endpoint
 * credentials, and backend-specific payloads never enter the model session.
 */
export class ExternalMemoryProvider implements MemoryProvider {
  readonly kind = 'external' as const
  private readonly metrics: MemoryPluginMetrics
  private readonly now: () => number

  constructor(
    private readonly binding: ExternalMemoryBinding,
    private readonly deps: ExternalMemoryRuntimeDeps
  ) {
    this.metrics = deps.metrics ?? defaultMemoryPluginMetrics
    this.now = deps.now ?? Date.now
  }

  runtimeEnv(): Record<string, string> {
    throw new Error('ExternalMemoryProvider.runtimeEnv must not be called — use memoryProviderFor at spawn')
  }

  async ensure(): Promise<void> {}

  async standingContextAtSessionStart(): Promise<string> {
    // External recall is query-dependent and runs on every activation. It must
    // never become a leading session/title block.
    return ''
  }

  recallPolicy(): RecallPolicy {
    return { ...this.binding.recall }
  }

  async recallForTurn(scope: MemoryScope, req: RecallRequest): Promise<MemoryRecord[]> {
    if (this.binding.recall.mode === 'tool-only' || !req.query.trim()) return []
    const startedAt = this.now()
    try {
      const { client, config } = this.connection()
      const output = await client.recall(
        {
          context: {
            requestId: randomUUID(),
            connection: { id: this.binding.connectionId, config },
            scope: { kind: 'agent', key: canonicalAgentMemoryKey(scope.agentId) }
          },
          query: req.query,
          topK: this.binding.recall.topK,
          maxBytes: this.binding.recall.maxBytes
        },
        { timeoutMs: this.binding.recall.timeoutMs, ...(req.signal ? { signal: req.signal } : {}) }
      )
      this.deps.registry.markRecovered(this.binding.connectionId, ['recall_unavailable', 'health_unavailable'])
      this.metrics.recall({
        durationMs: Math.max(0, this.now() - startedAt),
        outcome: output.records.length ? 'ok' : 'empty',
        resultCount: output.records.length
      })
      return output.records
    } catch (error) {
      this.deps.registry.markDegraded(this.binding.connectionId, 'recall_unavailable')
      this.metrics.recall({
        durationMs: Math.max(0, this.now() - startedAt),
        outcome: 'error',
        resultCount: 0
      })
      throw error
    }
  }

  async recordTurn(scope: MemoryScope, turn: TurnRecord): Promise<void> {
    if (this.binding.capture.mode !== 'turn' || !turn.output.trim()) return
    return this.recordTurnWithTarget(scope, turn, this.prepareCaptureTarget())
  }

  prepareCaptureTarget(): PreparedExternalMemoryCapture {
    const { client, config, spec } = this.connection()
    // Connection config is protocol-validated JSON data. Clone it now so an
    // in-memory spec update during the turn cannot mutate the captured target.
    const capturedConfig = JSON.parse(JSON.stringify(config)) as Record<string, unknown>
    return {
      connectionId: this.binding.connectionId,
      connectionRevision: spec.revision,
      pluginId: client.manifest.plugin.id,
      manifestDigest: client.manifestDigest,
      config: capturedConfig,
      idempotency: client.manifest.capabilities.idempotency
    }
  }

  async recordTurnWithTarget(
    scope: MemoryScope,
    turn: TurnRecord,
    target: PreparedExternalMemoryCapture | undefined
  ): Promise<void> {
    if (this.binding.capture.mode !== 'turn' || !turn.output.trim()) return
    if (!turn.turnId) throw new MemoryProviderUnavailableError('external memory capture requires a stable turn id')
    if (!target || target.connectionId !== this.binding.connectionId) {
      throw new MemoryProviderUnavailableError('external memory capture target is unavailable')
    }
    const result = this.deps.outbox.enqueue({
      agentId: scope.agentId,
      ...target,
      turnId: turn.turnId,
      ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
      input: turn.input,
      output: turn.output
    })
    if (result.status === 'full') {
      throw new MemoryProviderUnavailableError('external memory capture outbox is full')
    }
    if (result.status === 'conflict') {
      throw new MemoryProviderUnavailableError('external memory capture operation identity conflicted')
    }
  }

  tools(): ToolDescriptor[] {
    const { client } = this.connection()
    return externalMemoryTools(new Set(client.manifest.capabilities.operations))
  }

  toolsForAgent(): ToolDescriptor[] {
    return this.tools()
  }

  adminSurface(): RecordMemoryAdmin {
    const { client } = this.connection()
    const capabilities = new Set(client.manifest.capabilities.operations)
    return {
      shape: 'records',
      capabilities,
      search: (scope, req) => this.searchRecords(scope, req),
      list: (scope, req) =>
        this.adminCall('list', async () => {
          const connection = this.connection()
          const output = await connection.client.list({
            context: this.callContext(scope, connection),
            ...(req.cursor ? { cursor: req.cursor } : {}),
            limit: req.limit
          })
          return { records: output.records, ...(output.nextCursor ? { nextCursor: output.nextCursor } : {}) }
        }),
      get: (scope, id) =>
        this.adminCall('get', async () => {
          const connection = this.connection()
          return (await connection.client.get({ context: this.callContext(scope, connection), id })).record
        }),
      create: (scope, req) =>
        this.adminCall('create', async () => {
          const connection = this.connection()
          return (
            await connection.client.create({
              context: this.callContext(scope, connection),
              operationId: req.operationId,
              text: req.text,
              ...(req.metadata ? { metadata: req.metadata } : {})
            })
          ).record
        }),
      update: (scope, req) =>
        this.adminCall('update', async () => {
          const connection = this.connection()
          return (
            await connection.client.update({
              context: this.callContext(scope, connection),
              operationId: req.operationId,
              id: req.id,
              text: req.text,
              ...(req.metadata ? { metadata: req.metadata } : {}),
              ...(req.version ? { version: req.version } : {})
            })
          ).record
        }),
      delete: (scope, req) =>
        this.adminCall('delete', async () => {
          const connection = this.connection()
          return (
            await connection.client.delete({
              context: this.callContext(scope, connection),
              operationId: req.operationId,
              id: req.id,
              ...(req.version ? { version: req.version } : {})
            })
          ).deleted
        }),
      history: (scope, req) =>
        this.adminCall('history', async () => {
          const connection = this.connection()
          const output = await connection.client.history({
            context: this.callContext(scope, connection),
            id: req.id,
            ...(req.cursor ? { cursor: req.cursor } : {}),
            limit: req.limit
          })
          return { events: output.events, ...(output.nextCursor ? { nextCursor: output.nextCursor } : {}) }
        })
    }
  }

  async list(): Promise<MemoryEntry[]> {
    throw new MemoryProviderUnavailableError('external memory uses records, not files')
  }

  async read(_scope: MemoryScope, path: string): Promise<MemoryReadResult> {
    throw new MemoryProviderUnavailableError(`external memory cannot read file ${path}`)
  }

  async write(_scope: MemoryScope, path: string): Promise<MemoryWriteResult> {
    throw new MemoryProviderUnavailableError(`external memory cannot write file ${path}`)
  }

  private connection(): { client: MemoryPluginClient; config: Record<string, unknown>; spec: MemoryConnectionSpec } {
    const spec = this.deps.registry.specFor(this.binding.connectionId)
    const client = this.deps.registry.clientFor(this.binding.connectionId)
    if (!spec || !client) {
      throw new MemoryProviderUnavailableError('external memory connection is temporarily unavailable')
    }
    return { client, config: spec.config, spec }
  }

  private callContext(
    scope: MemoryScope,
    connection: { config: Record<string, unknown> }
  ): {
    requestId: string
    connection: { id: string; config: Record<string, unknown> }
    scope: { kind: 'agent'; key: string }
  } {
    return {
      requestId: randomUUID(),
      connection: { id: this.binding.connectionId, config: connection.config },
      scope: { kind: 'agent', key: canonicalAgentMemoryKey(scope.agentId) }
    }
  }

  private async searchRecords(scope: MemoryScope, req: RecallRequest): Promise<MemoryRecord[]> {
    return this.adminCall('recall', async () => {
      const connection = this.connection()
      return (
        await connection.client.recall(
          {
            context: this.callContext(scope, connection),
            query: req.query,
            topK: req.topK,
            maxBytes: req.maxBytes
          },
          { timeoutMs: req.timeoutMs, ...(req.signal ? { signal: req.signal } : {}) }
        )
      ).records
    })
  }

  private async adminCall<T>(operation: MemoryPluginOperation, call: () => Promise<T>): Promise<T> {
    try {
      const result = await call()
      this.deps.registry.markRecovered(this.binding.connectionId, [
        `admin_${operation}_unavailable`,
        'health_unavailable'
      ])
      return result
    } catch (error) {
      if (error instanceof MemoryPluginConflictError) {
        throw new MemoryConflictError('memory record changed since the supplied version')
      }
      if (error instanceof MemoryPluginInputError) {
        throw new MemoryTooLargeError(error.message)
      }
      this.deps.registry.markDegraded(this.binding.connectionId, `admin_${operation}_unavailable`)
      throw error
    }
  }
}

/**
 * `DispatchingMemoryProvider` — the daemon's single `MemoryProvider`. Routes every
 * scope-bearing call to the agent's configured concrete provider (managed | native),
 * built lazily and cached (both are stateless facades over the resolvers). `external`
 * throws `MemoryProviderUnavailableError` when first needed.
 *
 * `runtimeEnv` is NOT the dispatch path (it has no scope); it throws here to make the
 * misuse obvious — the spawn path uses `memoryProviderFor` directly.
 */
export class DispatchingMemoryProvider implements MemoryProvider {
  readonly kind = 'managed' as const // nominal; real kind is per-agent

  private managed: ManagedMemoryProvider
  private native: NativeMemoryProvider
  private none: NoMemoryProvider

  private readonly providerKindFor: (agentId: string) => MemoryProviderKind
  private readonly externalBindingFor: (agentId: string) => ExternalMemoryBinding | undefined
  private readonly externalDeps: ExternalMemoryRuntimeDeps | undefined

  constructor(deps: MemoryProviderDeps) {
    this.providerKindFor = deps.providerKindFor
    this.externalBindingFor = deps.externalBindingFor ?? (() => undefined)
    this.externalDeps = deps.externalDeps
    this.managed = new ManagedMemoryProvider(deps.memoryFsFor, deps.autoDistillFor ?? (() => false), deps.extract)
    this.native = new NativeMemoryProvider(deps.agentDirByAgent, deps.runtimeFor)
    this.none = new NoMemoryProvider()
  }

  private forAgent(agentId: string): MemoryProvider {
    const kind = this.providerKindFor(agentId)
    if (kind === 'managed') return this.managed
    if (kind === 'native') return this.native
    if (kind === 'none') return this.none
    const binding = this.externalBindingFor(agentId)
    if (!binding || !this.externalDeps) {
      throw new MemoryProviderUnavailableError('external memory runtime is not available')
    }
    return new ExternalMemoryProvider(binding, this.externalDeps)
  }

  private forBinding(agentId: string, binding: AgentMemoryBinding | undefined): MemoryProvider {
    if (!binding || binding.provider === 'managed') return this.managed
    if (binding.provider === 'native') return this.native
    if (binding.provider === 'none') return this.none
    if (!this.externalDeps) throw new MemoryProviderUnavailableError('external memory runtime is not available')
    if (binding.provider === 'external') return new ExternalMemoryProvider(binding, this.externalDeps)
    throw new MemoryProviderUnavailableError(`memory provider for agent ${agentId} is unsupported`)
  }

  runtimeEnv(_runtime: RuntimeDef): Record<string, string> {
    throw new Error('DispatchingMemoryProvider.runtimeEnv must not be called — use memoryProviderFor at spawn')
  }

  ensure(scope: MemoryScope, agentName: string): Promise<void> {
    return this.forAgent(scope.agentId).ensure(scope, agentName)
  }
  standingContextAtSessionStart(scope: MemoryScope): Promise<string> {
    return this.forAgent(scope.agentId).standingContextAtSessionStart(scope)
  }
  recallForTurn(scope: MemoryScope, req: RecallRequest): Promise<MemoryRecord[]> {
    return this.forAgent(scope.agentId).recallForTurn(scope, req)
  }
  recallPolicy(scope: MemoryScope): RecallPolicy {
    return this.forAgent(scope.agentId).recallPolicy(scope)
  }
  recordTurn(scope: MemoryScope, turn: TurnRecord): Promise<CaptureReceipt | void> {
    return this.forAgent(scope.agentId).recordTurn(scope, turn)
  }
  /** Post-delivery work is routed through the binding captured at turn start, so
   * a concurrent provider/connection switch can never retarget an old turn. */
  recordTurnForBinding(
    scope: MemoryScope,
    turn: TurnRecord,
    binding: AgentMemoryBinding | undefined,
    target?: PreparedExternalMemoryCapture
  ): Promise<CaptureReceipt | void> {
    const provider = this.forBinding(scope.agentId, binding)
    return provider instanceof ExternalMemoryProvider
      ? provider.recordTurnWithTarget(scope, turn, target)
      : provider.recordTurn(scope, turn)
  }
  /** Capture the exact external definition before a turn starts. */
  captureTargetForBinding(binding: AgentMemoryBinding | undefined): PreparedExternalMemoryCapture | undefined {
    if (binding?.provider !== 'external' || binding.capture.mode !== 'turn' || !this.externalDeps) return undefined
    return new ExternalMemoryProvider(binding, this.externalDeps).prepareCaptureTarget()
  }
  list(scope: MemoryScope): Promise<MemoryEntry[]> {
    return this.forAgent(scope.agentId).list(scope)
  }
  read(scope: MemoryScope, path: string): Promise<MemoryReadResult> {
    return this.forAgent(scope.agentId).read(scope, path)
  }
  write(
    scope: MemoryScope,
    path: string,
    content: string,
    ifMatch?: string,
    source?: MemoryWriteSource
  ): Promise<MemoryWriteResult> {
    return this.forAgent(scope.agentId).write(scope, path, content, ifMatch, source)
  }

  /** The memory tools to inject for a specific agent (the daemon calls this in
   *  `mcpServersFor` — native contributes none). Scope-carrying, unlike the
   *  interface's scopeless `tools()`. */
  toolsForAgent(agentId: string): ToolDescriptor[] {
    return this.forAgent(agentId).toolsForAgent(agentId)
  }

  adminSurfaceForAgent(agentId: string): MemoryAdminSurface {
    return this.forAgent(agentId).adminSurface()
  }

  adminSurface(): null {
    // A dispatcher has no implicit agent scope. Callers that know the agent must
    // use adminSurfaceForAgent(); failing closed prevents an external provider
    // from being accidentally projected as the managed file surface.
    return null
  }

  /** Interface `tools()` has no scope; the daemon uses `toolsForAgent`. Return the
   *  managed set as a safe default (never the live injection path). */
  tools(): ToolDescriptor[] {
    return MEMORY_TOOLS
  }
}

/** The daemon-side memory provider kind for an agent (absent ⇒ managed default). */
export function memoryKindOf(agent: { memory?: { provider?: MemoryProviderKind } }): MemoryProviderKind {
  return agent.memory?.provider ?? 'managed'
}

/**
 * Build the concrete provider for ONE agent — used at spawn (`daemon.ts` / `chat.ts`)
 * to source `runtimeEnv`, and validated eagerly so a misconfigured agent (external,
 * or native on an unregistered runtime) fails loudly with the agent's root bound.
 * Throws `MemoryProviderUnavailableError` on an unbuildable provider.
 */
export function memoryProviderFor(
  agent: {
    dir: string
    runtime?: string
    memory?: { provider?: MemoryProviderKind; connectionId?: string }
  },
  runtime: RuntimeDef,
  effectiveEnv: NodeJS.ProcessEnv = {},
  externalAdmission?: { assertReady(connectionId: string): void }
): { runtimeEnv(): Record<string, string> } {
  const kind = memoryKindOf(agent)
  // Managed keeps a single store: turn OFF any verified runtime-owned memory (see ManagedMemoryProvider.runtimeEnv).
  if (kind === 'managed') return { runtimeEnv: () => disabledRuntimeMemoryEnv(runtime, effectiveEnv, agent.runtime) }
  if (kind === 'none') {
    const p = new NoMemoryProvider()
    return { runtimeEnv: () => p.runtimeEnv(runtime, effectiveEnv, agent.runtime) }
  }
  if (kind === 'native') {
    if (!isNativeRuntimeSupported(runtime, agent.runtime)) {
      throw new MemoryProviderUnavailableError(
        `native memory is not supported for this runtime (env levers unverified): ${describeRuntime(runtime, agent.runtime)}`
      )
    }
    // Bind the agent root so runtimeEnv can compute the redirect target.
    return { runtimeEnv: () => nativeRuntimeEnv(runtime, agent.dir, agent.runtime) }
  }
  const connectionId = agent.memory?.connectionId
  if (!connectionId) throw new MemoryProviderUnavailableError('external memory connection id is missing')
  if (!externalAdmission) {
    throw new MemoryProviderUnavailableError('external memory connection registry is not available')
  }
  return {
    runtimeEnv: () => {
      externalAdmission.assertReady(connectionId)
      // External is the sole persistent store, so it carries the same strict
      // native-memory off-switch requirement as provider=none.
      return disabledRuntimeMemoryEnv(runtime, effectiveEnv, agent.runtime, 'external')
    }
  }
}

/** The daemon-side resolvers the dispatcher routes on. */
export interface MemoryProviderDeps {
  /** The port over the agent's MANAGED memory tree — the daemon's one placement decision. */
  memoryFsFor: (agentId: string) => MemoryFs | undefined
  /** The agent's LOCAL root: the runtime's own (native) memory is redirected under it. */
  agentDirByAgent: (agentId: string) => string | undefined
  runtimeFor: (agentId: string) => RuntimeDef | undefined
  providerKindFor: (agentId: string) => MemoryProviderKind
  autoDistillFor?: (agentId: string) => boolean
  extract?: MemoryExtractor
  externalBindingFor?: (agentId: string) => ExternalMemoryBinding | undefined
  externalDeps?: ExternalMemoryRuntimeDeps
}

/** Build the daemon's dispatching memory provider over the agent resolvers. */
export function createMemoryProvider(deps: MemoryProviderDeps): DispatchingMemoryProvider {
  return new DispatchingMemoryProvider(deps)
}

/** A managed-only provider (used where per-agent dispatch isn't needed, e.g. tests). */
export function createManagedMemoryProvider(memoryFsFor: (agentId: string) => MemoryFs | undefined): MemoryProvider {
  return new ManagedMemoryProvider(memoryFsFor)
}
